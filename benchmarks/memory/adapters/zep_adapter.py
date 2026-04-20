#!/usr/bin/env python3
import hashlib
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import urlparse
from typing import Any, Dict, List

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _bench_protocol import serve  # noqa: E402

BASE_URL = (os.environ.get('ZEP_BASE_URL') or 'https://api.getzep.com/api/v2').rstrip('/')
API_KEY = os.environ.get('ZEP_API_KEY')


def is_local_base_url(url: str) -> bool:
    host = (urlparse(url).hostname or '').lower()
    return host in {'localhost', '127.0.0.1', '::1', '0.0.0.0', 'host.docker.internal'}


def request_json(method: str, path: str, body: Dict[str, Any] | None = None) -> Any:
    headers = {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'User-Agent': 'owletto-zep-benchmark-adapter',
    }
    if API_KEY:
        headers['Authorization'] = f'Api-Key {API_KEY}'
    elif not is_local_base_url(BASE_URL):
        raise RuntimeError(
            'Missing ZEP_API_KEY. For Zep Cloud, set ZEP_API_KEY. For a local self-hosted instance, set ZEP_BASE_URL to your local API base (for example http://localhost:8000/api/v2).'
        )

    data = json.dumps(body).encode('utf-8') if body is not None else None

    max_retries = int(os.environ.get('ZEP_MAX_RETRIES') or 5)
    attempt = 0
    while True:
        req = urllib.request.Request(
            f"{BASE_URL}/{path.lstrip('/')}",
            data=data,
            headers=headers,
            method=method,
        )
        try:
            with urllib.request.urlopen(req, timeout=60) as response:
                raw = response.read().decode('utf-8')
                return json.loads(raw) if raw else None
        except urllib.error.HTTPError as exc:
            body_text = exc.read().decode('utf-8', 'ignore')
            if exc.code == 429 and attempt < max_retries:
                retry_after = 0.0
                header_value = exc.headers.get('Retry-After') if exc.headers else None
                if header_value:
                    try:
                        retry_after = float(header_value)
                    except ValueError:
                        retry_after = 0.0
                wait_seconds = max(retry_after, min(60.0, 2.0 * (2 ** attempt)))
                time.sleep(wait_seconds)
                attempt += 1
                continue
            raise RuntimeError(f'Zep API error {exc.code}: {body_text}') from exc
        except urllib.error.URLError as exc:
            raise RuntimeError(f'Zep request failed: {exc}') from exc


def scope_user_id(payload: Dict[str, Any]) -> str:
    run_id = str(payload.get('runId') or 'benchmark-run')
    suffix = hashlib.sha1(run_id.encode('utf-8')).hexdigest()[:16]
    return f'owletto-bench-{suffix}'


def normalize_metadata(metadata: Dict[str, Any] | None) -> Dict[str, Any]:
    if not metadata:
        return {}
    normalized: Dict[str, Any] = {}
    for key, value in metadata.items():
        if isinstance(value, (str, int, float, bool)) or value is None:
            normalized[key] = value
        elif isinstance(value, list) and all(
            isinstance(item, (str, int, float, bool)) or item is None for item in value
        ):
            normalized[key] = value
        else:
            normalized[key] = json.dumps(value, sort_keys=True)
    return normalized


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


def action_reset(payload: Dict[str, Any]) -> Any:
    user_id = scope_user_id(payload)
    try:
        request_json('DELETE', f'users/{user_id}')
    except Exception:
        pass
    return None


def action_setup(payload: Dict[str, Any]) -> Any:
    user_id = scope_user_id(payload)
    request_json(
        'POST',
        'users',
        {
            'user_id': user_id,
            'metadata': {
                'source': 'owletto-memory-benchmark',
            },
        },
    )
    return {'user_id': user_id}


def action_ingest(payload: Dict[str, Any]) -> Any:
    scenario = payload.get('scenario') or {}
    steps = scenario.get('steps') or []
    episodes: List[Dict[str, Any]] = []

    for step in steps:
        content = step.get('content')
        if not isinstance(content, str) or not content.strip():
            continue

        base_metadata = normalize_metadata(step.get('metadata'))
        base_metadata.update(
            {
                'benchmark_id': step.get('id'),
                'scenario_id': scenario.get('id'),
                'step_kind': step.get('kind'),
            }
        )
        if step.get('kind') == 'memory':
            base_metadata['semantic_type'] = step.get('semanticType')
        elif step.get('kind') == 'relationship':
            base_metadata['relationship_type'] = step.get('relationshipType')

        parts = split_content(content)
        for index, part in enumerate(parts):
            metadata = dict(base_metadata)
            metadata['chunk_index'] = index
            metadata['chunk_count'] = len(parts)
            episodes.append(
                {
                    'type': 'text',
                    'data': part,
                    'metadata': metadata,
                }
            )

    if not episodes:
        return {'created': 0}

    result = request_json(
        'POST',
        'graph-batch',
        {
            'user_id': scope_user_id(payload),
            'episodes': episodes,
        },
    )

    # graph-batch is asynchronous; poll the last episode until processed=true.
    # Zep processes episodes in-order per user, so once the tail is processed,
    # everything earlier has completed as well. Polling only the tail keeps
    # request volume low (matters on free-tier global rate limits).
    created_episodes = result or []
    episode_uuids: List[str] = []
    for episode in created_episodes:
        if isinstance(episode, dict):
            uuid = episode.get('uuid') or episode.get('uuid_')
            if uuid:
                episode_uuids.append(str(uuid))

    wait_timeout = float(os.environ.get('ZEP_INGEST_WAIT_SECONDS') or 600)
    poll_interval = float(os.environ.get('ZEP_INGEST_POLL_INTERVAL') or 3.0)
    deadline = time.perf_counter() + wait_timeout
    last_error: str | None = None
    processed = False

    tail_uuid = episode_uuids[-1] if episode_uuids else None
    while tail_uuid and time.perf_counter() < deadline:
        try:
            detail = request_json('GET', f'graph/episodes/{tail_uuid}')
        except Exception as exc:  # pragma: no cover - best effort
            last_error = str(exc)
            detail = None
        if isinstance(detail, dict) and detail.get('processed') is True:
            processed = True
            break
        time.sleep(poll_interval)

    return {
        'created': len(created_episodes),
        'polled_tail': tail_uuid,
        'processed': processed,
        'wait_seconds': wait_timeout,
        'last_poll_error': last_error,
    }


def action_retrieve(payload: Dict[str, Any]) -> Any:
    top_k = int(payload.get('topK') or 8)
    started = time.perf_counter()
    result = request_json(
        'POST',
        'graph/search',
        {
            'user_id': scope_user_id(payload),
            'query': payload.get('prompt') or '',
            'scope': 'episodes',
            'limit': top_k,
            'max_characters': 12000,
        },
    )
    latency_ms = (time.perf_counter() - started) * 1000

    grouped: Dict[str, Dict[str, Any]] = {}
    for entry in result.get('episodes') or []:
        metadata = entry.get('metadata') if isinstance(entry.get('metadata'), dict) else {}
        benchmark_id = str(metadata.get('benchmark_id') or entry.get('uuid'))
        text = entry.get('content') or ''
        score = entry.get('score') or entry.get('relevance') or 0
        existing = grouped.get(benchmark_id)
        if existing is None:
            grouped[benchmark_id] = {
                'id': benchmark_id,
                'text': text,
                'score': score,
                'sourceType': 'memory',
                'metadata': metadata,
            }
            continue
        if text and text not in existing['text']:
            existing['text'] = f"{existing['text']}\n\n{text}".strip()
        existing['score'] = max(existing.get('score') or 0, score)

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
