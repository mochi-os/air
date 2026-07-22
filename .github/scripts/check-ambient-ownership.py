#!/usr/bin/env python3
# Copyright © 2026 Mochisoft OÜ
# SPDX-License-Identifier: AGPL-3.0-only
# This file is part of Mochi, licensed under the GNU AGPL v3 with the
# Mochi Application Interface Exception - see license.txt and license-exception.md.

"""check-ambient-ownership.py — flag Starlark access checks that grant access on
entity ownership without a real authenticated-user guard.

Mochi runs public actions as the entity owner (entity-scoped actions) or the first
administrator (class-level actions) for anonymous callers — see core/server/web.go
owner resolution and the memory note reference-public-action-runs-as-owner.
`mochi.entity.get(id)` and an app's `owned(id)` helper both resolve ownership
against that *thread-local* effective user, so for an anonymous request to a public
action they return the OWNER. An access helper that short-circuits to a grant:

    if mochi.entity.get(id): return True        # wikis bug, 2026-06-17
    if owned(id): return True                   # forums bug, 2026-06-17

therefore treats the anonymous caller as the owner and bypasses the access rules
below it. The fix is to gate the short-circuit on a real authenticated user:

    if user and mochi.entity.get(id): return True

This detector flags exactly that shape:
  `if <cond containing owned(...) | mochi.entity.get(...) | mochi.entity.owned(...)>: return True`
  (single- or two-line) whose condition contains no `user` reference, AND whose
  enclosing function has no earlier `if not a.user` / `if not user` early-return
  (the repositories check_admin_access pattern, which is already safe).

It deliberately does NOT flag the common, safe uses (`if owned(x): is_owner = ...`,
`if not owned(x): ...`, display enrichment) — only the `return True` grant.

Allowlist: a trailing `# access-ok: <reason>` on the if line or the line above.

Usage:
  check-ambient-ownership.py [paths...]       # report violations (exit 0)
  check-ambient-ownership.py --check [paths]  # exit 1 if any violation (CI/preflight)

Default paths (run from monorepo root): apps/*/*.star + apps/*/starlark/*.star.
"""
import re
import sys
from pathlib import Path

OWNERSHIP = re.compile(r'(\bowned\(|mochi\.entity\.(get|owned)\()')
IF_RE = re.compile(r'if\s+(.*?):\s*(.*)$')
ANON_GUARD = re.compile(r'if\s+not\s+(a\.user|user)\b')
DEF_RE = re.compile(r'^([\t ]*)def\s+(\w+)\s*\(')
ALLOW = 'access-ok:'


def indent_of(line):
    return len(line) - len(line.lstrip('\t '))


def functions(lines):
    """List of (name, start_idx, end_idx) — body is (start, end)."""
    out = []
    for i, line in enumerate(lines):
        m = DEF_RE.match(line)
        if not m:
            continue
        indent = len(m.group(1))
        end = len(lines)
        for j in range(i + 1, len(lines)):
            if lines[j].strip() == '':
                continue
            if indent_of(lines[j]) <= indent:
                end = j
                break
        out.append((m.group(2), i, end))
    return out


def enclosing(funcs, idx):
    for name, s, e in funcs:
        if s < idx < e:
            return name, s
    return None, None


def body_after(lines, i):
    """The statement controlled by a colon-terminated `if` on line i."""
    for j in range(i + 1, len(lines)):
        if lines[j].strip() == '':
            continue
        return lines[j].strip()
    return ''


def check_file(path):
    violations = []
    lines = Path(path).read_text(encoding='utf-8', errors='replace').splitlines()
    funcs = functions(lines)
    for i, line in enumerate(lines):
        stripped = line.strip()
        if not stripped.startswith('if '):
            continue
        m = IF_RE.match(stripped)
        if not m:
            continue
        cond, rest = m.group(1), m.group(2)
        if not OWNERSHIP.search(cond):
            continue
        body = rest if rest else body_after(lines, i)
        if body != 'return True':
            continue
        # Gated by a real authenticated user in the condition itself.
        if 'user' in cond:
            continue
        # Intentional exception annotated at the site.
        if ALLOW in line or (i > 0 and ALLOW in lines[i - 1]):
            continue
        # Function returns early on an anonymous caller before this short-circuit
        # (e.g. repositories check_admin_access: `if not a.user: return False`).
        name, fstart = enclosing(funcs, i)
        if fstart is not None and any(
            ANON_GUARD.match(lines[j].strip()) for j in range(fstart, i)
        ):
            continue
        violations.append((i + 1, name or '<module>', stripped))
    return violations


def expand(args):
    paths = []
    for a in args:
        p = Path(a)
        if p.is_dir():
            paths += sorted(p.rglob('*.star'))
        elif any(ch in a for ch in '*?['):
            paths += sorted(Path('.').glob(a))
        else:
            paths.append(p)
    return [p for p in paths if p.suffix == '.star' and p.is_file()]


def main():
    argv = sys.argv[1:]
    check = '--check' in argv
    argv = [a for a in argv if a != '--check']
    if argv:
        files = expand(argv)
    else:
        files = expand(['apps/*/*.star', 'apps/*/starlark/*.star'])

    total = 0
    for f in sorted(set(files)):
        for lineno, func, text in check_file(f):
            total += 1
            print(f'{f}:{lineno}: ownership grant without a.user guard '
                  f'in {func}(): {text}')

    if total:
        print(f'\n{total} ownership-grant short-circuit(s) without an a.user guard. '
              f'Gate with `if user and ...`, or annotate intentional cases with '
              f'`# access-ok: <reason>`.', file=sys.stderr)
        sys.exit(1 if check else 0)
    else:
        print('check-ambient-ownership: no ungated ownership grants found.')
        sys.exit(0)


if __name__ == '__main__':
    main()
