import hashlib
import json
import os
from pathlib import Path
import subprocess
import tarfile
import time

out = Path(os.environ['RUNNER_TEMP']) / 'ben-codex'
receipt = json.loads((out / 'plugin-receipt.json').read_text())
inputs = json.loads((out / 'old-inputs.json').read_text())
plugin = out / receipt['archiveFile']
core = out / 'core/openclaw-2026.11.5-ben-4fad25d1.tgz'
def digest(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()
assert digest(plugin) == receipt['sha256']
assert digest(core) == 'b01492ed04ec26d7d22c4ca0662427953ff1560548177e2f9ed345da544fc2ba'
uid, gid = os.getuid(), os.getgid()
assert uid != 0
cache = out / 'public-code-cache'
cache.mkdir()
phases = []
drop_identity = 'import os,sys;os.setgroups([]);os.setgid(int(sys.argv[2]));os.setuid(int(sys.argv[1]));os.execvpe(sys.argv[3],sys.argv[3:],os.environ)'
for phase in ['online', 'offline']:
    root = out / ('qualification-' + phase)
    home, prefix, temp, olddeps = [root / name for name in ['home','prefix','tmp','old-dependencies']]
    for p in [home,prefix,temp,olddeps]:
        p.mkdir(parents=True, mode=0o700)
    userconfig, globalconfig = root / 'empty-user.npmrc', root / 'empty-global.npmrc'
    userconfig.write_text(''); globalconfig.write_text('')
    state = home / '.openclaw'
    state.mkdir(mode=0o700)
    config = state / 'openclaw.json'
    config.write_text(json.dumps({'plugins':{'entries':{'codex':{'enabled':False,'config':{'discovery':{'enabled':False},'sessionCatalog':{'enabled':False},'supervision':{'enabled':False},'computerUse':{'enabled':False}}}}}})+'\n')
    (olddeps / 'package.json').write_text(json.dumps({'name':'ben-codex-old-public-dependencies','version':'0.0.0','private':True,**inputs['runtimeDependencies']})+'\n')
    env = {'PATH':str(prefix/'bin')+os.pathsep+os.environ['PATH'],'HOME':str(home),'TMPDIR':str(temp),'CODEX_HOME':str(home/'codex'),'XDG_CACHE_HOME':str(home/'cache'),'NODE_OPTIONS':'','CI':'true','OPENCLAW_STATE_DIR':str(state),'OPENCLAW_CONFIG_PATH':str(config),'OPENCLAW_NO_ONBOARD':'1','OPENCLAW_NO_PROMPT':'1','OPENCLAW_SKIP_PROVIDERS':'1','OPENCLAW_SKIP_CHANNELS':'1','OPENCLAW_DISABLE_BONJOUR':'1','npm_config_cache':str(cache),'NPM_CONFIG_CACHE':str(cache),'npm_config_prefix':str(prefix),'NPM_CONFIG_PREFIX':str(prefix),'npm_config_userconfig':str(userconfig),'NPM_CONFIG_USERCONFIG':str(userconfig),'npm_config_globalconfig':str(globalconfig),'NPM_CONFIG_GLOBALCONFIG':str(globalconfig),'npm_config_registry':'https://registry.npmjs.org/','npm_config_audit':'false','npm_config_fund':'false','npm_config_loglevel':'error','npm_config_offline':'true' if phase=='offline' else 'false','NPM_CONFIG_OFFLINE':'true' if phase=='offline' else 'false'}
    cli = prefix / 'bin/openclaw'
    commands = [('core-install',['npm','install','--global','--prefix',str(prefix),str(core)]),('old-public-runtime-dependencies',['npm','install','--prefix',str(olddeps),'--omit=dev']),('native-custom-plugin-install',[str(cli),'plugins','install',str(plugin),'--force','--no-enable','--accept-capabilities']),('native-plugin-inspect',[str(cli),'plugins','inspect','codex','--json']),('native-enablement',[str(cli),'config','get','plugins.entries.codex.enabled','--json'])]
    for name, command in commands:
        label = phase + '-' + name
        invocation = command
        if phase == 'offline':
            invocation = ['sudo','-n','unshare','--net','/usr/bin/env','-i',*[k+'='+v for k,v in env.items()],'/usr/bin/python3','-c',drop_identity,str(uid),str(gid),*command]
        start = time.monotonic()
        with (out/(label+'.stdout')).open('wb') as stdout,(out/(label+'.stderr')).open('wb') as stderr:
            try:
                result = subprocess.run(invocation,env=env,cwd=olddeps if name=='old-public-runtime-dependencies' else root,stdout=stdout,stderr=stderr,timeout=600)
                code = result.returncode
            except subprocess.TimeoutExpired:
                code = 124
        phases.append({'phase':phase,'command':name,'originalExit':code,'elapsedSeconds':time.monotonic()-start,'network':'none' if phase=='offline' else 'public npm registry, fresh HOME, empty npmrc','uid':uid})
        (out/'cache-phases.json').write_text(json.dumps(phases,indent=2)+'\n')
        (out/(label+'.exit')).write_text(str(code)+'\n')
        assert code == 0, label+' failed; preserve original result/log before retry'
        if name in ['core-install','native-custom-plugin-install']:
            build = json.loads((prefix/'lib/node_modules/openclaw/dist/build-info.json').read_text())
            assert build['buildId']=='2026.11.5-4fad25d192e9-2026-11-20T04-29-41.094Z' and build['commit']==os.environ['CORE_SOURCE'], 'Core was not the exact preserved archive'
        if name=='native-enablement':
            assert json.loads((out/(label+'.stdout')).read_text()) is False, '--no-enable changed disabled policy'
archive = out / 'paired-offline-npm-cacache.tar'
subprocess.run(['tar','-cf',str(archive),'-C',str(cache),'_cacache'],check=True)
with tarfile.open(archive) as package:
    members = package.getmembers()
    assert all(x.name=='_cacache' or x.name.startswith('_cacache/') for x in members)
    assert all(x.isfile() or x.isdir() for x in members)
    unpacked = sum(x.size for x in members)
value = {'schemaVersion':1,'status':'qualified','scope':'Fresh public code-only cache plus fresh native local-archive install while disabled; synthetic consent only, no live grants/config/auth/provider calls','core':{'version':'2026.11.5','sha256':digest(core),'buildId':'2026.11.5-4fad25d192e9-2026-11-20T04-29-41.094Z','commit':os.environ['CORE_SOURCE']},'plugin':{'version':'2026.11.5','sha256':receipt['sha256'],'sourceCommit':receipt['sourceCommit'],'operatorSource':True},'oldRuntimeDependencyManifest':inputs['runtimeDependencies'],'cache':{'root':'_cacache','sha256':digest(archive),'archiveBytes':archive.stat().st_size,'unpackedBytes':unpacked},'producer':{'freshHome':True,'emptyNpmrc':True,'allowlistedEnv':True,'publicRegistry':'https://registry.npmjs.org/','cacheOnly':True,'offlineNetworkIsolation':'sudo-unshare-net-original-uid-gid-no-supplementary-groups','uid':uid,'gid':gid},'phases':phases,'runId':os.environ['GITHUB_RUN_ID'],'runAttempt':os.environ['GITHUB_RUN_ATTEMPT']}
(out/'paired-offline-cache-receipt.json').write_text(json.dumps(value,indent=2)+'\n')
print(json.dumps({'status':'qualified','sha256':value['cache']['sha256'],'archiveBytes':archive.stat().st_size,'phases':len(phases)}))
