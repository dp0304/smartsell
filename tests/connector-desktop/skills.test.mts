import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join, parse } from 'node:path';
import { test, type TestContext } from 'node:test';
import { installSkills } from '../../apps/connector-desktop/scripts/export-skills.mjs';
import catalog from '../../apps/connector-desktop/skills/catalog.json' with { type: 'json' };

const entries = await Promise.all(catalog.map(async ({ id }) => ({ id, content: await readFile(
  new URL(`../../apps/connector-desktop/skills/${id}/SKILL.md`, import.meta.url), 'utf8'),
})));

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'smartsell-skills-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('skills install from the canonical presets into both project layouts without replacing same-name entries', async t => {
  const project = await fixture(t);
  const reserved = join(project, '.claude', 'skills', entries[0].id);
  await mkdir(reserved, { recursive: true });
  await writeFile(join(reserved, 'notes.md'), 'user content');
  const first = await installSkills(project, entries);
  assert.equal(first.filter(row => row.installed).length, 5);
  assert.deepEqual(await readdir(reserved), ['notes.md']);
  for (const host of ['.claude', '.agents']) {
    for (const { id, content } of entries) {
      const dir = join(project, host, 'skills', id);
      if (dir === reserved) continue;
      assert(content.startsWith(`---\nname: ${id}\n`));
      assert.doesNotMatch(content.split('---', 3)[1], /^disable-model-invocation:\s*true\s*$/m);
      assert.equal(await readFile(join(dir, 'SKILL.md'), 'utf8'), content);
    }
  }
  const userSkill = join(project, '.agents', 'skills', entries[0].id, 'SKILL.md');
  await writeFile(userSkill, 'user skill');
  assert((await installSkills(project, entries)).every(row => !row.installed));
  assert.equal(await readFile(userSkill, 'utf8'), 'user skill');
});

test('skills reject linked parents, skip linked same-name entries and never write outside the project', async t => {
  const project = await fixture(t);
  const outside = await fixture(t);
  await symlink(outside, join(project, '.agents'), 'junction');
  await assert.rejects(installSkills(project, entries), /不跟随目录链接/);
  await assert.rejects(lstat(join(project, '.claude')), { code: 'ENOENT' });
  await rm(join(project, '.agents'));
  const root = join(project, '.agents', 'skills');
  await mkdir(root, { recursive: true });
  await symlink(outside, join(root, entries[0].id), 'junction');
  assert.equal((await installSkills(project, entries)).filter(row => row.installed).length, 5);
  assert.deepEqual(await readdir(outside), []);
});

test('skills reject invalid identifiers, filesystem root and home directory', async t => {
  const project = await fixture(t);
  await assert.rejects(installSkills(project, [{ id: '../escape', content: '' }]), /目录无效/);
  await assert.rejects(installSkills(project, [entries[0], entries[0]]), /目录无效/);
  await assert.rejects(installSkills(parse(project).root, entries), /文件系统根目录/);
  await assert.rejects(installSkills(homedir(), entries), /用户主目录/);
  assert.deepEqual(await readdir(project), []);
});
