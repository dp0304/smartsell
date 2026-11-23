import { lstat, mkdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { homedir } from 'node:os';

async function inspect(path) {
  return lstat(path).catch(error => {
    if (error.code !== 'ENOENT') throw error;
  });
}

async function verifyDirectory(path) {
  if (!(await lstat(path)).isDirectory() || relative(path, await realpath(path))) {
    throw new Error(`不是可用的普通目录（不跟随目录链接）：${path}`);
  }
}

async function ensureDirectory(path) {
  await verifyDirectory(dirname(path));
  await mkdir(path).catch(error => { if (error.code !== 'EEXIST') throw error; });
  await verifyDirectory(path);
  return path;
}

export async function installSkills(projectDirectory, entries) {
  const requested = resolve(projectDirectory);
  if (!(await inspect(requested))?.isDirectory()) throw new Error('请选择已存在的运维项目目录，不要选择目录链接。');
  const project = await realpath(requested);
  const home = await realpath(homedir());
  if (project === dirname(project) || !relative(home, project)) throw new Error('请选择运维项目，不要选择文件系统根目录或用户主目录。');
  const ids = entries.map(({ id }) => id);
  if (ids.some(id => !/^smartsell-[a-z0-9-]+$/.test(id)) || new Set(ids).size !== ids.length) throw new Error('内置 Skill 目录无效。');

  // Preflight both clients before creating any skill. Existing same-name entries belong to the user.
  const roots = [];
  for (const client of ['.claude', '.agents']) {
    const parent = join(project, client);
    const root = join(parent, 'skills');
    for (const path of [parent, root]) if (await inspect(path)) await verifyDirectory(path);
    roots.push(root);
  }
  const results = [];
  for (const root of roots) {
    await ensureDirectory(dirname(root));
    await ensureDirectory(root);
    for (const { id, content } of entries) {
      const directory = join(root, id);
      const path = relative(project, directory);
      await verifyDirectory(root);
      try { await mkdir(directory); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        results.push({ path, installed: false });
        continue;
      }
      await verifyDirectory(directory);
      await writeFile(join(directory, 'SKILL.md'), content, { flag: 'wx' });
      results.push({ path, installed: true });
    }
  }
  return results;
}

export async function run(entries, args = process.argv.slice(2)) {
  if (args.length !== 1 || !args[0] || args[0].startsWith('-')) {
    console.log('用法：node smartsell-install-skills.mjs <已存在的运维项目目录>');
    if (args.length !== 1 || args[0] !== '--help') process.exitCode = 1;
    return;
  }
  try {
    for (const { path, installed } of await installSkills(args[0], entries)) {
      console.log(`${installed ? '已安装' : '已存在，保留'}：${path}`);
    }
  } catch (error) {
    console.error(`无法安装 SmartSell Skills：${error.message}`);
    process.exitCode = 1;
  }
}
