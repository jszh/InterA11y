import argparse
import datetime
import json
import pathlib
import os
import signal
import shutil
import subprocess
import time
import uuid
HERE = pathlib.Path(__file__).resolve().parent
SELECTED_OUTPUTS = ('result.json', 'DetectedLNFs.txt', 'WTree.json')
ATTEMPT_OUTPUTS = SELECTED_OUTPUTS + ('acquisition.json', 'run.log', 'execution-error.json', 'provenance.json', 'classpath.txt', 'status.json', 'work')

def save_json(path, value):
    path.write_text(json.dumps(value, indent=2) + '\n')

def archive_outputs(output, names, prefix):
    existing = [output / name for name in names if (output / name).exists()]
    if not existing:
        return None
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S.%fZ')
    archive = output / 'history' / f'{prefix}-{stamp}-{uuid.uuid4().hex[:8]}'
    archive.mkdir(parents=True)
    for path in existing:
        shutil.move(str(path), str(archive / path.name))
    return archive

def execute(command, *, cwd=None, log=None):
    process = subprocess.run(command, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    if log is not None:
        log.write_text(process.stdout)
    if process.returncode:
        raise RuntimeError(f'Command failed ({process.returncode}): {command!r}\n' + process.stdout[-6000:])
    return process.stdout

def build(source):
    execute(['mvn', '-B', '-q', '-DskipTests', 'package'], cwd=source, log=source / 'portable-build.log')
    classpath_file = source / 'target' / 'portable-classpath.txt'
    execute(['mvn', '-B', '-q', 'dependency:build-classpath', f'-Dmdep.outputFile={classpath_file}'], cwd=source, log=source / 'portable-dependencies.log')
    classpath = str(source / 'target' / 'classes') + ':' + classpath_file.read_text().strip()
    wrapper_classes = source / 'target' / 'portable-wrapper'
    wrapper_classes.mkdir(parents=True, exist_ok=True)
    execute(['javac', '--release', '17', '-cp', classpath, '-d', str(wrapper_classes), str(HERE / 'PortableLynx.java')], log=source / 'portable-wrapper-build.log')
    return str(wrapper_classes) + ':' + classpath

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=pathlib.Path, required=True, help='Original NavigationDetection checkout')
    parser.add_argument('--url', help='Required for a URL run; not required with --build-only')
    parser.add_argument('--output', type=pathlib.Path, required=True)
    parser.add_argument('--classpath-file', type=pathlib.Path, help='Reuse a previously built full wrapper classpath')
    parser.add_argument('--build-only', action='store_true')
    parser.add_argument('--settle-ms', type=int, default=10000)
    parser.add_argument('--max-tabs', type=int, default=2000)
    parser.add_argument('--timeout', type=int, default=1800)
    parser.add_argument('--chrome-binary')
    args = parser.parse_args()
    if not args.build_only and (not args.url):
        parser.error('--url is required for a URL run; original detect-only invocation is Java-only')
    source = args.source.resolve()
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    reused_cp = None
    reuse_error = None
    if args.classpath_file:
        try:
            reused_cp = args.classpath_file.read_text().strip()
        except Exception as error:
            reuse_error = error
    prior_archive = archive_outputs(output, ATTEMPT_OUTPUTS, 'previous-attempt')
    started = time.monotonic()
    provenance = {'upstream': 'https://github.com/USC-SQL/NavigationDetection', 'source': str(source), 'url': args.url, 'algorithm': 'Original C-Tree construction, affinity functions, and six LNF heuristics', 'acquisition': 'Portable context-aware Selenium TAB adapter; explicit frame/open-shadow paths, composed geometry, finite observed first-discovery edges; not the original BAGEL crawler', 'previousAttemptArchive': str(prior_archive) if prior_archive else None, 'resolvedParameters': {'mode': 'build-only' if args.build_only else 'url', 'maxTabs': args.max_tabs, 'settleMs': args.settle_ms, 'processTimeoutSeconds': args.timeout, 'chromeBinary': args.chrome_binary, 'chromeArguments': ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--disable-extensions', '--ignore-certificate-errors'], 'browserWindow': {'width': 1280, 'height': 1024}, 'pageLoadStrategy': 'eager-with-stable-DOM-readiness', 'partialCoveragePolicy': 'Retain observed native-rule findings; cycles and unresolved coverage never imply a complete page traversal'}}
    state = {'state': 'running', 'phase': 'preparation'}
    save_json(output / 'status.json', state)
    try:
        if reuse_error:
            raise reuse_error
        run_attempt(args, source, output, reused_cp, provenance, state)
        (output / 'execution-error.json').unlink(missing_ok=True)
        state['state'] = 'build-complete' if args.build_only else 'complete'
    except Exception as error:
        failed_archive = archive_outputs(output, SELECTED_OUTPUTS, 'failed-selected-outputs')
        state['state'] = 'error'
        failure = {'error': type(error).__name__, 'message': str(error), 'phase': state['phase'], 'elapsedSeconds': time.monotonic() - started, 'failedOutputsArchive': str(failed_archive) if failed_archive else None, 'previousAttemptArchive': str(prior_archive) if prior_archive else None, 'note': 'Execution failure is not a passing accessibility result'}
        save_json(output / 'execution-error.json', failure)
        raise
    finally:
        provenance['launcherWallSeconds'] = time.monotonic() - started
        save_json(output / 'provenance.json', provenance)
        save_json(output / 'status.json', state)

def run_attempt(args, source, output, reused_cp, provenance, state):
    state['phase'] = 'build' if not args.classpath_file else 'classpath-reuse'
    save_json(output / 'status.json', state)
    cp = reused_cp if args.classpath_file else build(source)
    if not cp:
        raise ValueError('The wrapper classpath is empty')
    (output / 'classpath.txt').write_text(cp)
    if (source / '.git').exists():
        provenance['commit'] = execute(['git', 'rev-parse', 'HEAD'], cwd=source).strip()
        provenance['working_tree_status'] = execute(['git', 'status', '--porcelain'], cwd=source).strip()
    else:
        provenance['commit'] = None
    save_json(output / 'provenance.json', provenance)
    if args.build_only:
        print(output / 'classpath.txt')
        return
    job = output / 'work'
    (job / 'ctree' / 'page').mkdir(parents=True, exist_ok=True)
    (job / 'detected' / 'page').mkdir(parents=True, exist_ok=True)
    properties = {'mitmproxy_folder': 'mitmproxy-5.3.0', 'cached_subjects_location': str(job / 'unused-cache'), 'subject_URLs_location': str(job / 'subject_URLs.csv'), 'KFG_location': str(job / 'unused-kfg'), 'CTree_location': str(job / 'ctree'), 'Detection_output_location': str(job / 'detected')}
    (job / 'config.txt').write_text(''.join((f'{key}={value}\n' for key, value in properties.items())))
    (job / 'subjects.txt').write_text('page\n')
    import csv
    with (job / 'subject_URLs.csv').open('w', newline='') as stream:
        writer = csv.writer(stream)
        writer.writerow(['Subject', 'URL'])
        writer.writerow(['page', args.url])
    command = ['java', '-cp', cp, 'intera11y.research.PortableLynx', '--mode', 'url', '--subject', 'page', '--url', args.url, '--output', str(output), '--settle-ms', str(args.settle_ms), '--max-tabs', str(args.max_tabs)]
    if args.chrome_binary:
        command.extend(['--chrome-binary', args.chrome_binary])
    state['phase'] = 'java'
    save_json(output / 'status.json', state)
    try:
        process = subprocess.Popen(command, cwd=job, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, start_new_session=True)
        try:
            stdout, _ = process.communicate(timeout=args.timeout)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGTERM)
            try:
                stdout, _ = process.communicate(timeout=10)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                stdout, _ = process.communicate()
            (output / 'run.log').write_text(stdout)
            raise
        (output / 'run.log').write_text(stdout)
        if process.returncode:
            raise RuntimeError(f"LYNX exited {process.returncode}; see {output / 'run.log'}")
    except BaseException:
        if 'process' in locals() and process.poll() is None:
            os.killpg(process.pid, signal.SIGTERM)
            try:
                process.communicate(timeout=10)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.communicate()
        raise
    state['phase'] = 'output-validation'
    save_json(output / 'status.json', state)
    result = json.loads((output / 'result.json').read_text())
    if not isinstance(result.get('flagged'), bool) or not isinstance(result.get('findings'), list):
        raise ValueError('Java output is missing a boolean flagged result or findings list')
    empty_graph = result.get('candidateCount') == 0 and result.get('judgmentStatus') in {'NO_INITIAL_FOCUS_TARGETS', 'UNRESOLVED_ACQUISITION', 'UNRESOLVED_SAVED_PAGE_REPLAY'}
    if empty_graph:
        provenance['nativeDetectionExecuted'] = False
        provenance['nativeDetectionStatus'] = result['judgmentStatus']
    else:
        shutil.copy2(job / 'ctree/page/WTree.json', output / 'WTree.json')
        shutil.copy2(job / 'detected/page/DetectedLNFs.txt', output / 'DetectedLNFs.txt')
        provenance['nativeDetectionExecuted'] = True
    print(json.dumps(result, indent=2))
if __name__ == '__main__':
    main()
