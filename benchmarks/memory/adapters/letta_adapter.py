#!/usr/bin/env python3
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import urlparse
from typing import Any, Dict, List, Tuple

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _bench_protocol import serve  # noqa: E402

BASE_URL = (os.environ.get('LETTA_BASE_URL') or 'https://api.letta.com').rstrip('/')
API_KEY = os.environ.get('LETTA_API_KEY')
STATE_DIR = Path(os.environ.get('LETTA_BENCHMARK_STATE_DIR', '/tmp/owletto-letta-benchmark'))
BENCHMARK_PREFIX = '[[benchmark_id:'


def is_local_base_url(url: str) -> bool:
    host = (urlparse(url).hostname or '').lower()
    return host in {'localhost', '127.0.0.1', '::1', '0.0.0.0', 'host.docker.internal'}


def request_json(method: str, path: str, body: Dict[str, Any] | None = None) -> Any:
    headers = {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (owletto-letta-benchmark-adapter)',
    }
    if API_KEY:
        headers['Authorization'] = f'Bearer {API_KEY}'
    elif not is_local_base_url(BASE_URL):
        raise RuntimeError(
            'Missing LETTA_API_KEY. For Letta Cloud, set LETTA_API_KEY. For a local self-hosted instance, set LETTA_BASE_URL to your local API base.'
        )

    data = json.dumps(body).encode('utf-8') if body is not None else None
    req = urllib.request.Request(
        f'{BASE_URL}{path}',
        data=data,
        headers=headers,
        method=method,
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as response:
            return json.loads(response.read().decode('utf-8'))
    except urllib.error.HTTPError as exc:
        body_text = exc.read().decode('utf-8', 'ignore')
        raise RuntimeError(f'Letta API error {exc.code}: {body_text}') from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f'Letta request failed: {exc}') from exc


def state_path(run_id: str) -> Path:
    return STATE_DIR / f'{run_id}.json'


def read_state(run_id: str) -> Dict[str, Any]:
    path = state_path(run_id)
    if not path.exists():
        raise RuntimeError(f'No Letta benchmark state found for run {run_id!r}')
    return json.loads(path.read_text())


def write_state(run_id: str, state: Dict[str, Any]) -> None:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    state_path(run_id).write_text(json.dumps(state))


def split_content(content: str, max_chars: int = 9500) -> List[str]:
    text = content.strip()
    if len(text) <= max_chars:
        return [text]

    paragraphs = text.split('\n\n')
    chunks: List[str] = []
    current = ''
    for paragraph in paragraphs:
        paragraph = paragraph.strip()
        if not paragraph:
            continue
        candidate = f'{current}\n\n{paragraph}'.strip() if current else paragraph
        if len(candidate) <= max_chars:
            current = candidate
            continue
        if current:
            chunks.append(current)
            current = ''
        while len(paragraph) > max_chars:
            chunks.append(paragraph[:max_chars])
            paragraph = paragraph[max_chars:]
        current = paragraph
    if current:
        chunks.append(current)
    return chunks or [text[:max_chars]]


def encode_text(benchmark_id: str, text: str) -> str:
    return f'{BENCHMARK_PREFIX}{benchmark_id}]]\n{text.strip()}'


def decode_text(text: str) -> Tuple[str | None, str]:
    match = re.match(r'^\[\[benchmark_id:([^\]]+)\]\]\n?(.*)$', text, re.DOTALL)
    if not match:
        return None, text
    return match.group(1), match.group(2).strip()


def action_reset(payload: Dict[str, Any]) -> Any:
    run_id = str(payload.get('runId') or 'benchmark-run')
    path = state_path(run_id)
    if path.exists():
        try:
            state = json.loads(path.read_text())
            archive_id = state.get('archive_id')
            if archive_id:
                request_json('DELETE', f'/v1/archives/{archive_id}')
        except Exception:
            pass
        path.unlink()
    return None


def action_setup(payload: Dict[str, Any]) -> Any:
    run_id = str(payload.get('runId') or 'benchmark-run')
    archive = request_json(
        'POST',
        '/v1/archives/',
        {'name': f'owletto-bench-{run_id}'[:120]},
    )
    write_state(run_id, {'archive_id': archive['id'], 'passages': [], 'flushed': False})
    return {'archive_id': archive['id']}


def action_ingest(payload: Dict[str, Any]) -> Any:
    run_id = str(payload.get('runId') or 'benchmark-run')
    state = read_state(run_id)
    archive_id = state['archive_id']
    scenario = payload.get('scenario') or {}
    steps = scenario.get('steps') or []
    passages: List[Dict[str, Any]] = list(state.get('passages') or [])
    created = 0

    for step in steps:
        content = step.get('content')
        benchmark_id = step.get('id')
        if not isinstance(content, str) or not content.strip() or not benchmark_id:
            continue
        for part in split_content(content):
            passages.append({'text': encode_text(str(benchmark_id), part)})
            created += 1

    state['passages'] = passages
    state['flushed'] = False
    write_state(run_id, state)
    return {'created': created, 'archive_id': archive_id, 'buffered': len(passages)}


def action_retrieve(payload: Dict[str, Any]) -> Any:
    run_id = str(payload.get('runId') or 'benchmark-run')
    state = read_state(run_id)
    archive_id = state['archive_id']
    top_k = int(payload.get('topK') or 8)

    if not state.get('flushed'):
        passages = state.get('passages') or []
        if passages:
            request_json(
                'POST',
                f'/v1/archives/{archive_id}/passages/batch',
                {'passages': passages},
            )
        state['passages'] = []
        state['flushed'] = True
        write_state(run_id, state)

    started = time.perf_counter()
    result = request_json(
        'POST',
        '/v1/passages/search',
        {
            'query': payload.get('prompt') or '',
            'archive_id': archive_id,
            'limit': top_k,
        },
    )
    latency_ms = (time.perf_counter() - started) * 1000

    grouped: Dict[str, Dict[str, Any]] = {}
    for entry in result:
        passage = entry.get('passage') or {}
        benchmark_id, clean_text = decode_text(passage.get('text') or '')
        item_id = benchmark_id or passage.get('id')
        if not item_id:
            continue
        existing = grouped.get(item_id)
        if existing is None:
            grouped[item_id] = {
                'id': item_id,
                'text': clean_text,
                'score': entry.get('score'),
                'sourceType': 'memory',
                'metadata': {},
            }
            continue
        if clean_text and clean_text not in existing['text']:
            existing['text'] = f"{existing['text']}\n\n{clean_text}".strip()
        existing['score'] = max(existing.get('score') or 0, entry.get('score') or 0)

    items = sorted(grouped.values(), key=lambda item: item.get('score') or 0, reverse=True)
    return {'items': items[:top_k], 'latencyMs': latency_ms, 'raw': result}


ACTIONS = {
    'reset': action_reset,
    'setup': action_setup,
    'ingest': action_ingest,
    'retrieve': action_retrieve,
}


if __name__ == '__main__':
    raise SystemExit(serve(ACTIONS))
