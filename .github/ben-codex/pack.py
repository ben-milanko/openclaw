import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import subprocess
import tarfile

out = Path(os.environ['RUNNER_TEMP']) / 'ben-codex'
out.mkdir(exist_ok=True)
inputs = json.loads((Path(__file__).parent / 'old-inputs.json').read_text())
source = subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip()
tree = subprocess.check_output(['git', 'rev-parse', 'HEAD^{tree}'], text=True).strip()
assert source == os.environ['EXPECTED_SOURCE'] and tree == os.environ['EXPECTED_TREE']
assert not subprocess.check_output(['git', 'status', '--porcelain'], text=True).strip()
with (out / 'pack.stdout').open('wb') as stdout, (out / 'pack.stderr').open('wb') as stderr:
    result = subprocess.run(['node', '--import', './scripts/tsx.mjs', 'scripts/lib/plugin-npm-build-and-pack.mts', 'extensions/codex', str(out)], stdout=stdout, stderr=stderr)
(out / 'pack.exit').write_text(str(result.returncode) + '\n')
assert result.returncode == 0, 'Canonical plugin build/pack failed; original logs retained'
packed = json.loads((out / 'pack.stdout').read_text())
assert len(packed) == 1 and packed[0]['name'] == '@openclaw/codex' and packed[0]['version'] == '2026.11.5'
archive = out / packed[0]['filename']
assert archive.name == 'openclaw-codex-2026.11.5.tgz' and archive.stat().st_size < 128 * 1024**2
port_files = []
with tarfile.open(archive) as package:
    names = set()
    for member in package.getmembers():
        parts = PurePosixPath(member.name).parts
        assert parts and parts[0] == 'package' and '..' not in parts
        assert member.isfile() or member.isdir(), 'Unexpected link/special package member'
        assert member.name not in names
        names.add(member.name)
        assert PurePosixPath(member.name).name not in {'.npmrc', 'auth.json', 'auth-profiles.json', 'openclaw.json'}
        if member.isfile() and member.name.endswith(('.js', '.mjs')):
            code = package.extractfile(member).read().decode()
            if all(term in code for term in ['callerRunId', 'terminalOwner', 'runMirrorIdentityPrefix']):
                port_files.append(member.name)
    manifest = json.load(package.extractfile('package/openclaw.plugin.json'))
    metadata = json.load(package.extractfile('package/package.json'))
assert manifest['id'] == 'codex' and metadata['version'] == '2026.11.5'
assert metadata['openclaw']['compat']['pluginApi'] == '>=2026.11.5'
assert port_files, 'Caller-terminal custom port missing from canonical runtime'
(out / 'packed-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
(out / 'packed-package.json').write_text(json.dumps(metadata, indent=2) + '\n')
(out / 'old-inputs.json').write_text(json.dumps(inputs, indent=2) + '\n')
script = '''import fs from "node:fs";import assert from "node:assert/strict";
import {buildPluginCapabilitySummary,computeDeclaredSurfaceHash,diffDeclaredSurfaceWidening} from "./src/plugins/capability-summary.ts";
const [out]=process.argv.slice(1);const old=JSON.parse(fs.readFileSync(out+"/old-inputs.json")).capabilityManifest;const packed=JSON.parse(fs.readFileSync(out+"/packed-manifest.json"));
const previous=buildPluginCapabilitySummary({manifest:old,origin:"global"}).declared;const next=buildPluginCapabilitySummary({manifest:packed,origin:"global"}).declared;const difference=diffDeclaredSurfaceWidening(previous,next);assert.deepEqual(next,previous,"Packed capabilities changed");assert.equal(difference.hasWidening,false);
fs.writeFileSync(out+"/capability-diff.json",JSON.stringify({status:"passed",source:"canonical capability-summary.ts",previous,next,previousHash:computeDeclaredSurfaceHash(previous),nextHash:computeDeclaredSurfaceHash(next),difference,sourceTrust:"operator archive, NOT verified official; native artifact consent remains required"},null,2)+"\\n");'''
cap = subprocess.run(['node', '--import', './scripts/tsx.mjs', '--input-type=module', '-e', script, str(out)])
(out / 'capability.exit').write_text(str(cap.returncode) + '\n')
assert cap.returncode == 0
target = out / 'openclaw-codex-2026.11.5-ben-f16ac416.tgz'
archive.rename(target)
with target.open('rb') as stream:
    digest = hashlib.file_digest(stream, 'sha256').hexdigest()
receipt = {'status':'verified','scope':'Canonical standalone operator Codex archive only; no official provenance/live install/consent/inference acceptance','sourceCommit':source,'sourceTree':tree,'version':'2026.11.5','packageName':'@openclaw/codex','archiveFile':target.name,'sha256':digest,'bytes':target.stat().st_size,'npmIntegrity':packed[0]['integrity'],'originalBuildPackExit':result.returncode,'canonicalCapabilityDiffExit':cap.returncode,'customTerminalPortFiles':port_files,'oldOperatorArchiveSha256':inputs['archiveSha256'],'runId':os.environ['GITHUB_RUN_ID'],'runAttempt':os.environ['GITHUB_RUN_ATTEMPT']}
(out / 'plugin-receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
assert not subprocess.check_output(['git', 'status', '--porcelain'], text=True).strip()
print(json.dumps(receipt))
