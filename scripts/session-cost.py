#!/usr/bin/env python3
"""What a session cost by its transcripts: the main thread and every subagent, to check the status line against.

Usage: scripts/session-cost.py <session-id | path to its .jsonl>

The engine's total also prices requests no transcript keeps (compaction, titles), so it may read a little higher.
"""
import glob
import json
import os
import sys

# US dollars per million tokens: input, output, cache read, from platform.claude.com/docs/en/about-claude/pricing.
# A cache write costs 1.25x input for 5 minutes, 2x for 1 hour.
PRICES = {
    'claude-fable-5-1': (10.00, 50.00, 0.25),
    'claude-fable-5': (10.00, 50.00, 1.00),
    'claude-opus-5-5': (4.00, 20.00, 0.20),
    'claude-opus-5': (5.00, 25.00, 0.50),
    'claude-sonnet-5-5': (2.00, 10.00, 0.10),
    'claude-sonnet-5': (2.00, 10.00, 0.20),
    'claude-haiku-5-5': (0.10, 0.50, 0.01),
}
# Haiku 5.5 bills a prompt over 100K tokens at five times its rates.
LONG_PROMPT = {'claude-haiku-5-5': (100_000, 5)}


def find(arg):
    if os.path.isfile(arg):
        return arg
    config = os.environ.get('CLAUDE_CONFIG_DIR') or os.path.expanduser('~/.claude')
    found = glob.glob(os.path.join(config, 'projects', '*', f'{arg}.jsonl'))
    if not found:
        sys.exit(f'No transcript for session {arg} under {config}/projects')
    return found[0]


def responses(path):
    """Each API response's model and usage, by message id; a response files a row per block, the last one complete."""
    found = {}
    with open(path) as lines:
        for line in lines:
            try:
                row = json.loads(line)
            except ValueError:
                continue
            message = row.get('message') if isinstance(row, dict) else None
            if row.get('type') == 'assistant' and isinstance(message, dict) and message.get('id') and message.get('usage'):
                found[message['id']] = message
    return found


def cost(message, unpriced):
    usage = message['usage']
    model = message.get('model', '?')
    if model not in PRICES:
        unpriced.add(model)
        return 0.0
    price_in, price_out, price_read = PRICES[model]
    writes = usage.get('cache_creation') or {}
    write_1h = writes.get('ephemeral_1h_input_tokens', 0)
    write_5m = usage.get('cache_creation_input_tokens', 0) - write_1h
    usd = (
        usage.get('input_tokens', 0) * price_in
        + write_5m * price_in * 1.25
        + write_1h * price_in * 2
        + usage.get('cache_read_input_tokens', 0) * price_read
        + usage.get('output_tokens', 0) * price_out
    ) / 1e6
    prompt = usage.get('input_tokens', 0) + usage.get('cache_creation_input_tokens', 0) + usage.get('cache_read_input_tokens', 0)
    limit, factor = LONG_PROMPT.get(model, (None, 1))
    if limit is not None and prompt > limit:
        usd *= factor
    # Fast mode bills twice the standard rate.
    return usd * 2 if usage.get('speed') == 'fast' else usd


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__.strip())
    path = find(sys.argv[1])
    seen = set()
    unpriced = set()
    lines = []

    def tally(label, transcript):
        # A fork's transcript repeats its parent's responses: count each once, where first seen.
        fresh = {id: m for id, m in responses(transcript).items() if id not in seen}
        seen.update(fresh)
        usd = sum(cost(m, unpriced) for m in fresh.values())
        models = sorted({m.get('model', '?') for m in fresh.values()})
        lines.append((label, len(fresh), usd, ', '.join(models)))
        return usd

    total = tally('main thread', path)
    for transcript in sorted(glob.glob(os.path.join(path[: -len('.jsonl')], 'subagents', '*.jsonl'))):
        try:
            with open(transcript[: -len('.jsonl')] + '.meta.json') as file:
                meta = json.load(file)
            label = f"{meta.get('agentType', 'agent')}: {meta.get('description', '')}"
        except (OSError, ValueError):
            label = os.path.basename(transcript)
        total += tally(label, transcript)

    width = max(len(label) for label, *_ in lines)
    for label, count, usd, models in lines:
        print(f'{label:<{width}}  {count:>4} responses  ${usd:>8.2f}  {models}')
    print(f"{'total':<{width}}  {'':>14}  ${total:>8.2f}")
    if unpriced:
        print(f"Left out, no price for: {', '.join(sorted(unpriced))}", file=sys.stderr)


main()
