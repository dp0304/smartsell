// Snapshot and behaviour tests for pnpm hub:service (§2.8, §10.1 S1). Nothing here installs a service: plans are
// generated and compared, and every command goes through a scripted exec.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  agentPlistPath, DAEMON_PLIST, launchdPlist, planInstall, planUninstall, plistProgram, serviceMain, serviceNodeIssue, serviceState, stableNodePath,
  utf16le, validateMode, versionedNodePath, windowsTaskXml, xmlEscape,
} from './hub-service.mjs';

const mac = { nodePath: '/opt/homebrew/opt/node@24/bin/node', repo: '/Users/owner/smartsell', hubDir: '/Users/owner/Library/Application Support/SmartSell Hub' };
const win = { nodePath: 'C:\\Program Files\\nodejs\\node.exe', repo: 'C:\\Users\\owner\\smartsell', hubDir: 'C:\\Users\\owner\\AppData\\Local\\SmartSell Hub', userId: 'WIN-C\\owner' };

const AGENT_PLIST = String.raw`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.smartsell.hub</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/opt/node@24/bin/node</string>
    <string>--import</string>
    <string>tsx</string>
    <string>/Users/owner/smartsell/apps/server/hub.ts</string>
  </array>
  <key>WorkingDirectory</key><string>/Users/owner/smartsell</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>SMARTSELL_HUB_DIR</key><string>/Users/owner/Library/Application Support/SmartSell Hub</string>
    <key>PATH</key><string>/opt/homebrew/opt/node@24/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key><false/>
  </dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>/Users/owner/Library/Application Support/SmartSell Hub/logs/hub.out.log</string>
  <key>StandardErrorPath</key><string>/Users/owner/Library/Application Support/SmartSell Hub/logs/hub.err.log</string>
</dict>
</plist>
`;

const DAEMON_PLIST_SNAPSHOT = String.raw`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.smartsell.hub</string>
  <key>UserName</key><string>owner</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/opt/node@24/bin/node</string>
    <string>--import</string>
    <string>tsx</string>
    <string>/Users/owner/smartsell/apps/server/hub.ts</string>
  </array>
  <key>WorkingDirectory</key><string>/Users/owner/smartsell</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>SMARTSELL_HUB_DIR</key><string>/Users/owner/Library/Application Support/SmartSell Hub</string>
    <key>PATH</key><string>/opt/homebrew/opt/node@24/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key><false/>
  </dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>/Users/owner/Library/Application Support/SmartSell Hub/logs/hub.out.log</string>
  <key>StandardErrorPath</key><string>/Users/owner/Library/Application Support/SmartSell Hub/logs/hub.err.log</string>
</dict>
</plist>
`;

const LOGON_XML = String.raw`<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>SmartSell Hub (pnpm hub:service install --mode logon)</Description>
    <URI>\SmartSell Hub</URI>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>WIN-C\owner</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>WIN-C\owner</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>999</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>C:\Program Files\nodejs\node.exe</Command>
      <Arguments>--import tsx &quot;C:\Users\owner\smartsell\apps\server\hub.ts&quot; --supervise --hub-dir &quot;C:\Users\owner\AppData\Local\SmartSell Hub&quot;</Arguments>
      <WorkingDirectory>C:\Users\owner\smartsell</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;

const BOOT_XML = String.raw`<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>SmartSell Hub (pnpm hub:service install --mode boot)</Description>
    <URI>\SmartSell Hub</URI>
  </RegistrationInfo>
  <Triggers>
    <BootTrigger>
      <Enabled>true</Enabled>
    </BootTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>WIN-C\owner</UserId>
      <LogonType>Password</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>999</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>C:\Program Files\nodejs\node.exe</Command>
      <Arguments>--import tsx &quot;C:\Users\owner\smartsell\apps\server\hub.ts&quot; --supervise --hub-dir &quot;C:\Users\owner\AppData\Local\SmartSell Hub&quot;</Arguments>
      <WorkingDirectory>C:\Users\owner\smartsell</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;

test('LaunchAgent plist (agent) matches the snapshot', () => {
  assert.equal(launchdPlist(mac), AGENT_PLIST);
});

test('LaunchDaemon plist (daemon) matches the snapshot and runs as the owner', () => {
  assert.equal(launchdPlist({ ...mac, userName: 'owner' }), DAEMON_PLIST_SNAPSHOT);
});

test('Task Scheduler XML (logon) matches the snapshot', () => {
  assert.equal(windowsTaskXml({ ...win, mode: 'logon' }), LOGON_XML);
});

test('Task Scheduler XML (boot) matches the snapshot', () => {
  assert.equal(windowsTaskXml({ ...win, mode: 'boot' }), BOOT_XML);
});

test('the snapshots carry the settings §2.8 requires', () => {
  for (const plist of [AGENT_PLIST, DAEMON_PLIST_SNAPSHOT]) {
    assert.match(plist, /<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key><false\/>/);
    assert.match(plist, /<key>ThrottleInterval<\/key><integer>10<\/integer>/);
    assert.match(plist, /<key>RunAtLoad<\/key><true\/>/);
    assert.match(plist, /<key>SMARTSELL_HUB_DIR<\/key>/);
  }
  assert.doesNotMatch(AGENT_PLIST, /UserName/);
  for (const xml of [LOGON_XML, BOOT_XML]) {
    assert.match(xml, /<RestartOnFailure>\s*<Interval>PT1M<\/Interval>\s*<Count>999<\/Count>/);
    assert.match(xml, /<ExecutionTimeLimit>PT0S<\/ExecutionTimeLimit>/);
    assert.match(xml, /<DisallowStartIfOnBatteries>false<\/DisallowStartIfOnBatteries>/);
    assert.match(xml, /<StopIfGoingOnBatteries>false<\/StopIfGoingOnBatteries>/);
    assert.match(xml, /<WorkingDirectory>C:\\Users\\owner\\smartsell<\/WorkingDirectory>/);
  }
  // AO-2 (E45): RestartOnFailure never re-runs a task whose program started and exited non-zero; the supervisor does.
  for (const xml of [LOGON_XML, BOOT_XML]) assert.match(xml, /hub\.ts&quot; --supervise --hub-dir/);
  assert.match(LOGON_XML, /<LogonTrigger>[\s\S]*<LogonType>InteractiveToken<\/LogonType>/);
  assert.match(BOOT_XML, /<BootTrigger>[\s\S]*<LogonType>Password<\/LogonType>/);
});

test('XML escaping and the UTF-16LE encoding schtasks expects', () => {
  assert.equal(xmlEscape(`a&b<c>"d'`), 'a&amp;b&lt;c&gt;&quot;d&apos;');
  assert.match(launchdPlist({ ...mac, hubDir: '/Users/o/R&D <hub>' }), /<string>\/Users\/o\/R&amp;D &lt;hub&gt;<\/string>/);
  const encoded = utf16le('<a>\n</a>');
  assert.deepEqual([...encoded.subarray(0, 2)], [0xff, 0xfe]);
  assert.equal(encoded.subarray(2).toString('utf16le'), '<a>\r\n</a>');
});

const target = (platform, mode) => ({ platform, mode, ...(platform === 'win32' ? win : mac), home: '/Users/owner', uid: 501, userName: 'owner',
  userId: platform === 'win32' ? win.userId : 'owner' });
const argv = plan => plan.commands.map(command => command.argv.join(' '));

test('install plans: agent, daemon, logon, boot', () => {
  const agent = planInstall(target('darwin', 'agent'));
  assert.deepEqual(agent.files.map(file => file.path), ['/Users/owner/Library/LaunchAgents/com.smartsell.hub.plist']);
  assert.equal(agent.files[0].content, AGENT_PLIST);
  assert.deepEqual(argv(agent), ['launchctl bootout gui/501/com.smartsell.hub', 'launchctl enable gui/501/com.smartsell.hub',
    'launchctl bootstrap gui/501 /Users/owner/Library/LaunchAgents/com.smartsell.hub.plist']);
  assert.equal(agent.commands[0].allowFailure, true);

  const daemon = planInstall(target('darwin', 'daemon'));
  assert.equal(daemon.files[0].content, DAEMON_PLIST_SNAPSHOT);
  assert.deepEqual(daemon.removes, [agentPlistPath('/Users/owner')]);
  assert.deepEqual(argv(daemon), [
    'launchctl bootout gui/501/com.smartsell.hub',
    `sudo install -m 0644 -o root -g wheel ${mac.hubDir}/com.smartsell.hub.daemon.plist ${DAEMON_PLIST}`,
    'sudo launchctl bootout system/com.smartsell.hub',
    `sudo launchctl bootstrap system ${DAEMON_PLIST}`,
  ]);
  assert.ok(daemon.commands.filter(command => command.argv[0] === 'sudo').every(command => command.interactive), 'sudo prompts in the terminal');

  const logon = planInstall(target('win32', 'logon'));
  assert.equal(logon.files[0].path, 'C:\\Users\\owner\\AppData\\Local\\SmartSell Hub\\smartsell-hub-task.xml');
  assert.equal(logon.files[0].content.subarray(2).toString('utf16le'), LOGON_XML.replace(/\n/g, '\r\n'));
  assert.deepEqual(argv(logon), ['schtasks /Create /TN SmartSell Hub /XML C:\\Users\\owner\\AppData\\Local\\SmartSell Hub\\smartsell-hub-task.xml /F',
    'schtasks /Run /TN SmartSell Hub']);

  const boot = planInstall(target('win32', 'boot'));
  assert.equal(boot.files[0].content.subarray(2).toString('utf16le'), BOOT_XML.replace(/\n/g, '\r\n'));
  assert.deepEqual(boot.commands[0].argv.slice(-5), ['/F', '/RU', 'WIN-C\\owner', '/RP', '*'], 'Windows prompts for the password; the script never sees it');
  assert.equal(boot.commands[0].interactive, true);
  assert.match(boot.notes.join('\n'), /安裝腳本不會經手/);
});

test('uninstall plans', () => {
  assert.deepEqual(argv(planUninstall(target('darwin', 'agent'))), ['launchctl bootout gui/501/com.smartsell.hub']);
  assert.deepEqual(planUninstall(target('darwin', 'agent')).removes, ['/Users/owner/Library/LaunchAgents/com.smartsell.hub.plist']);
  assert.deepEqual(argv(planUninstall(target('darwin', 'daemon'))), ['sudo launchctl bootout system/com.smartsell.hub', `sudo rm -f ${DAEMON_PLIST}`]);
  assert.deepEqual(argv(planUninstall(target('win32', 'boot'))), ['schtasks /End /TN SmartSell Hub', 'schtasks /Delete /TN SmartSell Hub /F']);
  assert.throws(() => validateMode('darwin', 'boot'), /agent 或 daemon/);
  assert.throws(() => validateMode('win32', 'agent'), /logon 或 boot/);
  assert.equal(validateMode('win32', 'boot'), 'boot');
});

function harness({ platform = 'darwin', rules = [], answer = false } = {}) {
  const calls = [];
  const lines = [];
  const written = [];
  const questions = [];
  const exec = async (file, args) => {
    const line = [file, ...args].join(' ');
    calls.push(line);
    const rule = rules.find(([fragment]) => line.includes(fragment));
    return { code: 0, stdout: '', stderr: '', ...(rule ? rule[1] : {}) };
  };
  return {
    calls, lines, written, questions,
    deps: { exec, platform, env: platform === 'win32' ? { USERDOMAIN: 'WIN-C', LOCALAPPDATA: 'C:\\Users\\owner\\AppData\\Local' } : {},
      home: '/Users/owner', uid: 501, userName: 'owner', nodePath: platform === 'win32' ? win.nodePath : mac.nodePath,
      repo: platform === 'win32' ? win.repo : mac.repo, log: line => lines.push(line),
      ask: async question => { questions.push(question); return answer; },
      writeFile: (path, content) => written.push(path), removeFile: path => written.push(`rm ${path}`), ensureDir: path => written.push(`mkdir ${path}`),
      fetch: async () => new Response('{}'), sleep: async () => {} },
  };
}

test('install refuses when hub.ts --check fails', async () => {
  const h = harness({ rules: [['hub.ts --check', { code: 1 }]] });
  assert.equal(await serviceMain(['install', '--hub-dir', mac.hubDir], h.deps), 1);
  assert.ok(h.calls[0].includes('apps/server/hub.ts --check --hub-dir'));
  assert.ok(h.calls[0].endsWith(' --load'), 'AO-1: the code and data are loaded too, not only the settings');
  assert.deepEqual(h.written, []);
  assert.ok(!h.calls.some(line => line.startsWith('launchctl')));
  assert.match(h.lines.join('\n'), /不安裝服務/);
});

test('install with FileVault on explains the three choices and asks; --dry-run writes nothing', async () => {
  const declined = harness({ rules: [['fdesetup status', { stdout: 'FileVault is On.' }]], answer: false });
  assert.equal(await serviceMain(['install', '--hub-dir', mac.hubDir], declined.deps), 1);
  const text = declined.lines.join('\n');
  assert.match(text, /FileVault 已開啟/);
  assert.match(text, /1\. 中樞關閉 FileVault/);
  assert.match(text, /2\. 保持 FileVault.*sudo fdesetup authrestart/);
  assert.match(text, /3\. 改用 Windows 機器當中樞/);
  assert.equal(declined.questions.length, 1);
  assert.deepEqual(declined.written, []);

  const dry = harness({ rules: [['fdesetup status', { stdout: 'FileVault is On.' }]] });
  assert.equal(await serviceMain(['install', '--hub-dir', mac.hubDir, '--yes', '--dry-run'], dry.deps), 0);
  assert.deepEqual(dry.written, []);
  assert.equal(dry.questions.length, 0);
  assert.ok(!dry.calls.some(line => line.startsWith('launchctl')), 'dry-run executes no launchctl command');
  assert.match(dry.lines.join('\n'), /\[dry-run\] 會寫入 \/Users\/owner\/Library\/LaunchAgents\/com\.smartsell\.hub\.plist/);
  assert.match(dry.lines.join('\n'), /sudo pmset -c sleep 0 disksleep 0/);
});

test('install runs the plan, then waits for /readyz', async () => {
  const h = harness({ rules: [['fdesetup status', { stdout: 'FileVault is Off.' }], ['defaults read', { stdout: 'owner\n' }]] });
  assert.equal(await serviceMain(['install', '--hub-dir', '/private/tmp/smartsell-hub-service-fixture-dir'], h.deps), 0);
  assert.deepEqual(h.written, ['mkdir /private/tmp/smartsell-hub-service-fixture-dir/logs', '/Users/owner/Library/LaunchAgents/com.smartsell.hub.plist']);
  assert.ok(h.calls.includes('launchctl bootstrap gui/501 /Users/owner/Library/LaunchAgents/com.smartsell.hub.plist'));
  assert.match(h.lines.at(-1), /並在執行中/);
});

test('Windows boot install passes /RU and /RP * to schtasks', async () => {
  const h = harness({ platform: 'win32' });
  assert.equal(await serviceMain(['install', '--mode', 'boot', '--hub-dir', win.hubDir, '--dry-run'], h.deps), 0);
  assert.match(h.lines.join('\n'), /schtasks \/Create \/TN "SmartSell Hub" \/XML .* \/F \/RU WIN-C\\owner \/RP \*/);
  assert.equal(await serviceMain(['bogus'], h.deps), 2);
});

test('status parsing for launchctl print and schtasks /Query', async () => {
  const launchctl = async () => ({ code: 0, stdout: 'gui/501/com.smartsell.hub = {\n\tstate = running\n\tpid = 4242\n}', stderr: '' });
  const home = '/private/tmp/smartsell-hub-service-home-without-plist';
  assert.equal((await serviceState('darwin', launchctl, home, 501)).installed, false, 'no plist → not installed');
  const schtasks = async () => ({ code: 0, stdout: 'HostName: WIN-C\nTaskName: \\SmartSell Hub\nStatus: Ready\n', stderr: '' });
  assert.deepEqual(await serviceState('win32', schtasks, 'C:\\Users\\owner', 0), { installed: true, running: false, text: '排程工作「SmartSell Hub」：Ready' });
  const missing = async () => ({ code: 1, stdout: '', stderr: 'ERROR: The system cannot find the file specified.' });
  assert.equal((await serviceState('win32', missing, 'C:\\Users\\owner', 0)).installed, false);
});

test('AO-3 (E45): the service file names Homebrew\'s stable opt path, not the versioned keg brew upgrade deletes', async () => {
  const keg = '/opt/homebrew/Cellar/node@24/24.11.0/bin/node';
  const opt = '/opt/homebrew/opt/node@24/bin/node';
  assert.equal(stableNodePath(keg, 'darwin', path => path === opt), opt);
  assert.equal(stableNodePath('/usr/local/Cellar/node/26.0.0/bin/node', 'darwin', path => path === '/usr/local/opt/node/bin/node'), '/usr/local/opt/node/bin/node');
  assert.equal(stableNodePath(keg, 'darwin', () => false), keg, 'no opt link: keep what runs');
  assert.equal(stableNodePath('/usr/local/bin/node', 'darwin', () => true), '/usr/local/bin/node');
  assert.equal(stableNodePath(win.nodePath, 'win32', () => true), win.nodePath);
  assert.equal(versionedNodePath(keg), true);
  assert.equal(versionedNodePath(opt), false);
  // serviceMain normalises the running node (process.execPath is the resolved keg path) before writing the plist.
  const written = [];
  const h = harness({ rules: [['fdesetup status', { stdout: 'FileVault is Off.' }], ['defaults read', { stdout: 'owner\n' }]] });
  delete h.deps.nodePath;
  Object.assign(h.deps, { execPath: keg, exists: path => path === opt, writeFile: (path, content) => written.push([path, content]) });
  assert.equal(await serviceMain(['install', '--hub-dir', '/private/tmp/smartsell-hub-service-fixture-dir'], h.deps), 0);
  assert.equal(plistProgram(written.find(([path]) => path.endsWith('.plist'))[1]), opt);
  assert.match(written[0][1], /<key>PATH<\/key><string>\/opt\/homebrew\/opt\/node@24\/bin:/);
  assert.ok(h.calls[0].startsWith(`${opt} --import tsx`), 'the check runs with the same node the service will use');
});

test('AO-3: an installed plist whose node is gone is an error; a versioned one a warning', () => {
  const plist = node => launchdPlist({ ...mac, nodePath: node });
  assert.equal(plistProgram(plist('/opt/homebrew/opt/node@24/bin/node')), '/opt/homebrew/opt/node@24/bin/node');
  assert.equal(plistProgram(launchdPlist({ ...mac, nodePath: '/Users/o/R&D/node' })), '/Users/o/R&D/node');
  const gone = serviceNodeIssue('/p.plist', { read: () => plist('/opt/homebrew/Cellar/node@24/24.11.0/bin/node'), exists: () => false });
  assert.equal(gone.level, 'error');
  assert.match(gone.text, /已不存在，多半是 brew upgrade 移除了舊版本.*pnpm hub:service install/);
  const versioned = serviceNodeIssue('/p.plist', { read: () => plist('/opt/homebrew/Cellar/node@24/24.11.0/bin/node'), exists: () => true });
  assert.equal(versioned.level, 'warn');
  assert.equal(serviceNodeIssue('/p.plist', { read: () => plist('/opt/homebrew/opt/node@24/bin/node'), exists: () => true }), undefined);
  assert.equal(serviceNodeIssue('/missing.plist', { read: () => { throw new Error('ENOENT'); } }), undefined);
});
