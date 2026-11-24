#!/usr/bin/env python3
# Copyright © 2026 Mochisoft OÜ
# SPDX-License-Identifier: AGPL-3.0-only
# This file is part of Mochi, licensed under the GNU AGPL v3 with the
# Mochi Application Interface Exception - see license.txt and license-exception.md.

"""check-ambient-ownership.py - flag Starlark that decides who the caller is
from data the request did not prove.

An anonymous request to a `public: true` action runs with the entity owner's
storage (a class-level action on a hosted domain route, with the route
owner's), and a signed-in request to a `"site": true` action on a domain route
carrying a context does too. Every mochi.db.* and mochi.file.* call then reads
the OWNER's data. mochi.entity.get(id), mochi.entity.owned() and
mochi.entity.owns(id) answer for the authenticated caller only (an empty list,
an error and False for an anonymous one), so a grant on them is sound. An
ownership or membership test that reads the app's own database is not: it
answers as the owner would, whoever asked.

Rules, each documented where it is implemented:

  1. A grant decided by stored ownership: in a function reachable from a public
     action, `if <condition>: return True` (or an access or ownership
     predicate's `return <condition>`) whose condition comes from a storage
     read - an `owner` column or query, or an ownership helper whose answer is
     read from storage - with no caller in it and no caller guard before it.
  2. An access helper (check_*access, can_*, *_can, require_*) that reaches
     `return True` before any reference to the caller.
  3. A stored ownership helper consulted in a public action before a caller
     guard.
  4. A helper whose return value is an ownership answer and which takes a
     caller identity it never tests. The ambient caller is not that identity:
     in an event handler it is the receiving owner, not the sender.
  5. mochi.entity.get(...) compared with None. It answers a list, never None.
  6. A whole-table read (no `where` clause binding a parameter) in a public
     action, or in a helper it calls, outside an `a.user` branch.
  7. In an event_* handler, mochi.access.allow, deny, revoke or clear.subject
     whose subject derives from e.header("from"): a peer editing its own rules.

The app's helpers are followed across every Starlark file of the app, found
from the nearest app.json above the file.

Allowlist: `# access-ok: <reason>` on the reported statement or the line above
it; for rules 2, 3 and 4 anywhere in the function or the comment block
immediately above its def.

Usage:
  check-ambient-ownership.py [paths...]       # report findings (exit 0)
  check-ambient-ownership.py --check [paths]  # exit 1 on any finding (CI/preflight)

Default path (run from monorepo root): apps, recursively. apps/test is exempt
(internal assertions). Exit 2 when nothing was scanned, a path does not exist,
or a file under apps/ has no app.json above it or its app.json cannot be read.

Tests: claude/scripts/test_check_ambient_ownership.py
"""
import json
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
GATE = 'check-ambient-ownership'
ALLOW = 'access-ok:'

DEF_RE = re.compile(r'^([\t ]*)def\s+(\w+)\s*\(')
WORD = re.compile(r'\b[A-Za-z_]\w*\b')
# A call of a bare name: an app helper. `x.name(` is a method, not one.
CALL = re.compile(r'(?<![\w.])([A-Za-z_]\w*)\s*\(')

# Reads of the request's storage account: under the substitution these answer
# with the owner's rows whoever asked.
STORAGE = re.compile(r'\bmochi\.(?:db\.(?:row|rows|exists)|file\.(?:read|exists|list))\s*\(')
# Core's caller-bound ownership calls: the authenticated requester, or nobody.
ENTITY = re.compile(r'\bmochi\.entity\.(?:get|owned|owns)\s*\(')
# An `owner` column, key or query term ("owner", owner=1, isOwner) - not
# ownername or owners_count.
OWNER_WORD = re.compile(r'(?:(?<![A-Za-z])owner|Owner)(?![a-z])')
# A helper named as an ownership or membership predicate: its name is the
# ownership signal when its storage read carries none.
OWNER_NAME = re.compile(
    r'^(owned|owns|is_\w*(?:owner|member|admin|moderator|manager)|\w+_owned|\w*member_of\w*)$')

# Rule 2 scopes by NAME, which keeps protocol helpers like market's
# _check_status out of it.
ACCESS_FN = re.compile(r'^(check_access|check_\w+_access|can_\w+|\w+_can|require_\w+)$')
# A bare `user` counts. Leaving it out made rule 2 flag the very shape that
# gates a grant on the caller - `if user and owned(id): return True` - which
# trains people to annotate `access-ok` around correct code.
CALLER = re.compile(
    r'\ba\.user\b|\buser\b|\buser_id\b|mochi\.access\.check\s*\(|\bcheck_\w*access\s*\('
)
RETURN_TRUE = re.compile(r'^return\s+True\s*$')
# A helper named as a yes-or-no question.
PREDICATE = re.compile(
    r'^(is_\w+|has_\w+|can_\w+|\w+_can|check_\w+|require_\w+|allowed|\w+_allowed|owned|owns|\w+_owned)$')

# Names that hold the caller: the request's user, or an identity a helper was
# asked about.
CALLER_USER = re.compile(r'\ba\.user\b')
CALLER_PARAM = re.compile(r'^(user|user_id|uid|identity|caller|viewer|member)$')
CALLER_TESTED = (
    r'(?:^|\s)(?:if|elif|while)\s+.*\b{name}\b'      # if not user_id / if user_id and ...
    r'|\b{name}\b\s*(?:==|!=)|(?:==|!=)\s*\b{name}\b'
)

ASSIGN = re.compile(r'^([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)\s*(?:[+|]?=)(?!=)\s*(.*)$', re.S)
FOR = re.compile(r'^for\s+(.+?)\s+in\s+(.*):\s*$', re.S)
IF = re.compile(r'^(if|elif)\s+(.*)$', re.S)
RETURN = re.compile(r'^return\s+(.+)$', re.S)
LITERAL = {'True', 'False', 'None'}

# Rule 7: the access calls that change a rule set, and the event's sender.
ACCESS_WRITE = re.compile(r'\bmochi\.access\.(?:allow|deny|revoke|clear\.subject)\s*\(')
SENDER = re.compile(r'\.header\s*\(\s*["\']from["\']\s*\)')

# Rule 6: the reads a whole-table select can come through.
TABLE_READ = re.compile(r'\bmochi\.db\.(?:rows|row|exists)\s*\(')


class ManifestError(Exception):
    """A file under apps/ with no app.json above it, or an app.json that
    cannot be read: the public actions are unknowable, so nothing about them
    may be reported clean."""


def indent_of(line):
    return len(line) - len(line.lstrip('\t '))


def decode(text):
    """Parse the JSON-with-comments-and-trailing-commas that app.json uses.
    A copy of check-duplicate-definitions.py's decode: the per-app mirrors of
    this script run where claude/scripts is not."""
    out = []
    index = 0
    length = len(text)
    inside = False
    escaped = False
    while index < length:
        character = text[index]
        if inside:
            out.append(character)
            if escaped:
                escaped = False
            elif character == "\\":
                escaped = True
            elif character == '"':
                inside = False
            index += 1
            continue
        if character == '"':
            inside = True
            out.append(character)
            index += 1
            continue
        if character == "/" and index + 1 < length and text[index + 1] == "/":
            while index < length and text[index] != "\n":
                index += 1
            continue
        if character == "/" and index + 1 < length and text[index + 1] == "*":
            index += 2
            while index + 1 < length and not (text[index] == "*" and text[index + 1] == "/"):
                index += 1
            index += 2
            continue
        out.append(character)
        index += 1
    return json.loads(re.sub(r",(\s*[}\]])", r"\1", "".join(out)))


def blank(text):
    """Two views of the source, each the length of `text`: `code` has comments
    blanked, `bare` has comments and string contents blanked (a string keeps
    its opening quote, and a one-line string its closing one), so brackets and
    names in strings and comments are not read as code."""
    code = []
    bare = []
    i = 0
    n = len(text)
    while i < n:
        c = text[i]
        if c == '#':
            j = text.find('\n', i)
            j = n if j < 0 else j
            code.append(' ' * (j - i))
            bare.append(' ' * (j - i))
            i = j
            continue
        if c in '"\'':
            quote = text[i:i + 3] if text[i:i + 3] in ('"""', "'''") else c
            j = i + len(quote)
            while j < n:
                if text[j] == '\\':
                    j += 2
                    continue
                if text.startswith(quote, j):
                    j += len(quote)
                    break
                if len(quote) == 1 and text[j] == '\n':
                    break
                j += 1
            j = min(j, n)
            segment = text[i:j]
            code.append(segment)
            hidden = [ch if ch == '\n' else ' ' for ch in segment]
            hidden[0] = segment[0]
            if len(quote) == 1 and len(segment) > 1 and segment.endswith(quote):
                hidden[-1] = segment[-1]
            bare.append(''.join(hidden))
            i = j
            continue
        code.append(c)
        bare.append(c)
        i += 1
    return ''.join(code), ''.join(bare)


def matching(bare, start):
    """Index just past the bracket closing the one at bare[start]."""
    depth = 0
    for k in range(start, len(bare)):
        ch = bare[k]
        if ch in '([{':
            depth += 1
        elif ch in ')]}':
            depth -= 1
            if depth == 0:
                return k + 1
    return len(bare)


def arguments_of(bare, opening):
    """(start, end) of each argument of the call whose `(` is at
    bare[opening]."""
    out = []
    start = opening + 1
    depth = 0
    for k in range(opening + 1, len(bare)):
        ch = bare[k]
        if ch in '([{':
            depth += 1
        elif ch in ')]}':
            if depth == 0:
                if bare[start:k].strip():
                    out.append((start, k))
                return out
            depth -= 1
        elif ch == ',' and depth == 0:
            out.append((start, k))
            start = k + 1
    if bare[start:].strip():
        out.append((start, len(bare)))
    return out


def first_argument(bare, opening):
    """(start, end) of the first argument of the call whose `(` is at
    bare[opening]."""
    spans = arguments_of(bare, opening)
    return spans[0] if spans else (opening + 1, opening + 1)


class Statement:
    """One logical line: a statement spanning bracketed continuation lines."""

    def __init__(self, source, first, last):
        self.first = first
        self.last = last
        self.indent = indent_of(source.lines[first])
        self.code = '\n'.join(source.code_lines[first:last + 1])[self.indent:]
        self.bare = '\n'.join(source.bare_lines[first:last + 1])[self.indent:]

    def text(self, source):
        return source.lines[self.first].strip()


class Source:
    """A Starlark file split into views, logical statements and functions."""

    def __init__(self, path):
        self.path = Path(path)
        text = self.path.read_text(encoding='utf-8', errors='replace').replace('\r\n', '\n')
        code, bare = blank(text)
        self.lines = text.split('\n')
        self.code_lines = code.split('\n')
        self.bare_lines = bare.split('\n')
        self.offsets = []
        position = 0
        for line in self.lines:
            self.offsets.append(position)
            position += len(line) + 1
        self.bare = bare
        self.statements = self.logical()
        # following[line]: the index of the first statement starting at or
        # after that line.
        self.following = []
        pointer = 0
        for line in range(len(self.lines) + 1):
            while pointer < len(self.statements) and self.statements[pointer].first < line:
                pointer += 1
            self.following.append(pointer)
        self.functions = [Function(self, name, start, end) for name, start, end in self.spans()]
        for function in self.functions:
            function.own(self.functions)

    def logical(self):
        out = []
        depth = 0
        first = None
        for i, line in enumerate(self.bare_lines):
            if first is None:
                if line.strip() == '':
                    continue
                first = i
            for ch in line:
                if ch in '([{':
                    depth += 1
                elif ch in ')]}':
                    depth = max(0, depth - 1)
            if depth == 0 and not line.rstrip().endswith('\\'):
                out.append(Statement(self, first, i))
                first = None
        if first is not None:
            out.append(Statement(self, first, len(self.bare_lines) - 1))
        return out

    def spans(self):
        """(name, start, end) for every def: the body is lines (start, end)."""
        out = []
        for i, line in enumerate(self.bare_lines):
            m = DEF_RE.match(line)
            if not m:
                continue
            indent = len(m.group(1))
            end = len(self.lines)
            for j in range(i + 1, len(self.lines)):
                if self.bare_lines[j].strip() == '':
                    continue
                if indent_of(self.bare_lines[j]) <= indent:
                    end = j
                    break
            out.append((m.group(2), i, end))
        return out

    def annotated(self, first, last):
        """`# access-ok:` on the statement's lines or the line above."""
        return any(ALLOW in self.lines[j] for j in range(max(0, first - 1), last + 1))

    def annotated_function(self, function):
        """The window is the body plus any contiguous comment block immediately
        above the def, stopping at the first non-comment line: a wider window
        reaches into the preceding function and silences an untouched
        neighbour."""
        top = function.start
        while top > 0:
            above = self.lines[top - 1].strip()
            if above == '' or above.startswith('#'):
                top -= 1
                continue
            break
        return any(ALLOW in self.lines[j] for j in range(top, function.end))


class Function:
    def __init__(self, source, name, start, end):
        self.source = source
        self.name = name
        self.start = start
        self.end = end
        index = source.following[start]
        statements = source.statements
        self.header = statements[index] if index < len(statements) and statements[index].first == start else None
        self.params = self.parameters()
        self.statements = []
        self.words = set()

    def parameters(self):
        if self.header is None:
            return []
        m = re.match(r'def\s+\w+\s*\((.*)\)\s*:', self.header.bare, re.S)
        if not m:
            return []
        out = []
        for part in m.group(1).split(','):
            name = part.split('=')[0].strip().lstrip('*').strip()
            if name:
                out.append(name)
        return out

    def own(self, functions):
        """The function's own statements: its body without nested defs."""
        nested = [(f.start, f.end) for f in functions
                  if f is not self and self.start < f.start < self.end]
        source = self.source
        self.statements = [
            s for s in source.statements[source.following[self.start + 1]:source.following[self.end]]
            if not any(a <= s.first < b for a, b in nested)
        ]
        body = '\n'.join(source.bare_lines[self.start + 1:self.end])
        self.words = set(WORD.findall(body))

    def body_code(self):
        """The function's code lines, comments removed."""
        return [self.source.code_lines[s.first + k]
                for s in self.statements for k in range(s.last - s.first + 1)]


class Scope:
    """What each local of one function carries: the caller, a storage read, an
    owner signal on that read, or a caller-bound ownership answer."""

    def __init__(self, function, app):
        self.function = function
        self.app = app
        self.callers = {p for p in function.params if CALLER_PARAM.match(p)}
        self.stored = set()
        # A parameter some call site fills with a local read from storage:
        # stored data in this function, but not a read of its own, so it never
        # makes the function's answer a stored one (an id handed to
        # mochi.entity.get is still the caller's question).
        marks = app.arguments.get(function.name, {})
        self.passed = set(marks.get('stored', ())) - self.callers
        self.owner = set(marks.get('owner', ())) - self.callers
        self.ambient = set()
        self.sender = set()
        for _ in range(3):
            if not self.spread():
                break

    def spread(self):
        grew = False
        for s in self.function.statements:
            m = ASSIGN.match(s.bare)
            targets, expression = None, None
            if m:
                targets = re.findall(r'\w+', m.group(1))
                start = m.start(2)
                expression = (s.code[start:], s.bare[start:])
            else:
                m = FOR.match(s.bare)
                if m:
                    targets = re.findall(r'\w+', m.group(1))
                    expression = (s.code[m.start(2):m.end(2)], s.bare[m.start(2):m.end(2)])
            if not targets:
                continue
            found = self.flags(*expression)
            for target in targets:
                for flag, names in (('caller', self.callers), ('stored', self.stored),
                                    ('passed', self.passed), ('owner', self.owner),
                                    ('ambient', self.ambient), ('sender', self.sender)):
                    if flag in found and target not in names:
                        names.add(target)
                        grew = True
        return grew

    def flags(self, code, bare):
        found = set()
        words = set(WORD.findall(bare))
        called = set(CALL.findall(bare))
        app = self.app
        if CALLER_USER.search(bare) or words & self.callers:
            found.add('caller')
        if STORAGE.search(bare) or called & app.stored or words & self.stored:
            found.add('stored')
        if words & self.passed:
            found.add('passed')
        if called & app.owning:
            found |= {'stored', 'owner'}
        # A row a query with an owner term selected answers ownership by being
        # there; a field taken from it (row["id"]) does not.
        if any(re.search(r'(?<![\w.])%s\b(?!\s*[\[.(])' % re.escape(name), bare)
               for name in words & self.owner):
            found.add('owner')
        # The signal is a column, key or query term, so it is read from the
        # string literals only: forward_to_owner(...) names no column.
        if found & {'stored', 'passed'} and OWNER_WORD.search(literals(code, bare)):
            found.add('owner')
        # Carried through predicates only: a helper that merely computes its
        # result with an ownership call along the way (a post it created, say)
        # does not answer the ownership question.
        if ENTITY.search(bare) or {c for c in called & app.ambient if PREDICATE.match(c)} \
                or words & self.ambient:
            found.add('ambient')
        if SENDER.search(code) or words & self.sender:
            found.add('sender')
        return found


def literals(code, bare):
    """The string literals' contents of an expression, everything else blank."""
    return ''.join(c if c != b else ' ' for c, b in zip(code, bare))


def stored_ownership(found):
    """An answer read from storage, carrying an owner signal, with no caller."""
    return bool(found & {'stored', 'passed'}) and 'owner' in found and 'caller' not in found


def condition_of(statement):
    """(condition code, condition bare, inline body bare) for an if/elif."""
    m = IF.match(statement.bare)
    if not m:
        return None
    start = m.start(2)
    bare = statement.bare
    depth = 0
    for k in range(start, len(bare)):
        ch = bare[k]
        if ch in '([{':
            depth += 1
        elif ch in ')]}':
            depth -= 1
        elif ch == ':' and depth == 0:
            return statement.code[start:k], bare[start:k], bare[k + 1:].strip()
    return None


def body_of(function, index):
    """The first statement of the block a header at statements[index] opens."""
    header = function.statements[index]
    for s in function.statements[index + 1:]:
        if s.indent > header.indent:
            return s
        return None
    return None


def polarity(condition_bare, scope):
    """+1 when the condition requires the caller, -1 when it is the anonymous
    branch (`not a.user`, `user_id == None`), 0 when it does not name the
    caller."""
    if not (CALLER_USER.search(condition_bare) or set(WORD.findall(condition_bare)) & scope.callers):
        return 0
    text = condition_bare.strip()
    if re.match(r'^not\s*\(', text):
        return -1
    negative = re.match(r'^not\s+(a\.user\b|(\w+)\b)', text)
    if negative and (negative.group(1).startswith('a.user') or negative.group(2) in scope.callers):
        return -1
    if re.match(r'^(a\.user[\w.]*|\w+)\s*(==\s*None|is\s+None)\b', text):
        return -1
    return 1


def exits(function, index):
    """Does the block (or inline body) of the header at index leave the function?"""
    header = function.statements[index]
    parts = condition_of(header)
    if parts and parts[2]:
        return bool(re.match(r'^(return|fail)\b|^a\.error', parts[2]))
    body = body_of(function, index)
    return body is not None and bool(re.match(r'^(return|fail)\b|^a\.error', body.bare))


def guarded(function, index, scope):
    """Has the caller been tested before statements[index] runs? Either a
    block holding it tests the caller (`if a.user:`, the else of
    `if not a.user:`), or an earlier statement at a level holding it tests the
    caller and leaves the function (`if not a.user: return`)."""
    statements = function.statements
    level = statements[index].indent
    for j in range(index - 1, -1, -1):
        s = statements[j]
        if s.indent > level:
            continue
        parts = condition_of(s)
        if s.indent < level:
            # A header whose block holds the statement.
            level = s.indent
            if parts and polarity(parts[1], scope) > 0:
                return True
            if re.match(r'^else\s*:', s.bare) and else_follows_negative(function, j, scope):
                return True
            continue
        if parts and polarity(parts[1], scope) != 0 and exits(function, j):
            return True
    return False


def else_follows_negative(function, index, scope):
    """Is the else at statements[index] the signed-in branch of an
    `if not a.user:` chain?"""
    indent = function.statements[index].indent
    for j in range(index - 1, -1, -1):
        s = function.statements[j]
        if s.indent > indent:
            continue
        if s.indent < indent:
            return False
        parts = condition_of(s)
        if parts and polarity(parts[1], scope) < 0:
            return True
        if not s.bare.startswith('elif'):
            return False
    return False


class App:
    """Every Starlark file of one app, its public actions, and what each of its
    functions answers with."""

    def __init__(self, manifest, paths):
        self.manifest = manifest
        self.public = public_functions(manifest) if manifest else set()
        self.sources = {}
        for path in paths:
            try:
                self.sources[Path(path)] = Source(path)
            except OSError:
                continue
        self.functions = {}
        for source in self.sources.values():
            for function in source.functions:
                self.functions.setdefault(function.name, []).append(function)
        self.stored = set()
        self.owning = set()
        self.primitive = set()
        self.ambient = set()
        self.wrappers = set()
        # function name -> {'stored': params, 'owner': params} its callers fill
        # from storage reads.
        self.arguments = {}
        self.classify()
        self.reach = self.reachable()
        self.scopes = {}

    def every(self):
        for functions in self.functions.values():
            yield from functions

    def scope(self, function):
        key = id(function)
        if key not in self.scopes:
            self.scopes[key] = Scope(function, self)
        return self.scopes[key]

    def classify(self):
        """Fixpoint over the app: which functions answer from storage (stored),
        with stored ownership (owning; primitive where an ownership-named
        helper answers straight from a read, as an owned() over the database
        does), with a caller-bound ownership answer (ambient), or with
        mochi.entity.get's list itself (wrappers)."""
        for _ in range(8):
            grew = False
            for function in self.every():
                scope = Scope(function, self)
                grew |= self.passed(function, scope)
                for index, s in enumerate(function.statements):
                    m = RETURN.match(s.bare)
                    if m:
                        start = m.start(1)
                        bare = s.bare[start:].strip()
                        if bare in LITERAL:
                            continue
                        found = scope.flags(s.code[start:], s.bare[start:])
                        predicate = ACCESS_FN.match(function.name) or OWNER_NAME.match(function.name)
                        # An answer annotated `access-ok` is declared sound
                        # and taints none of its callers.
                        sound = function.source.annotated(s.first, s.last)
                        if 'stored' in found and 'caller' not in found:
                            grew |= self.mark(self.stored, function.name)
                            if OWNER_NAME.match(function.name) and not sound:
                                grew |= self.mark(self.owning, function.name)
                                grew |= self.mark(self.primitive, function.name)
                        if predicate and stored_ownership(found) and not sound:
                            grew |= self.mark(self.owning, function.name)
                        if 'ambient' in found or stored_ownership(found):
                            grew |= self.mark(self.ambient, function.name)
                        if self.wraps(bare, scope):
                            grew |= self.mark(self.wrappers, function.name)
                        continue
                    parts = condition_of(s)
                    if not parts:
                        continue
                    following = None if parts[2] else body_of(function, index)
                    body = parts[2] or (following.bare.strip() if following else '')
                    if not RETURN_TRUE.match(body):
                        continue
                    last = following.last if following else s.last
                    if stored_ownership(scope.flags(parts[0], parts[1])) \
                            and not function.source.annotated(s.first, last):
                        grew |= self.mark(self.owning, function.name)
            if not grew:
                break

    def passed(self, function, scope):
        """Mark the parameters of the app functions this one calls with what
        it passes them: a row read from storage stays one in the helper. Only
        a local passed whole: an id taken from a row and handed to an
        ownership call is the caller's question, not a stored answer."""
        grew = False
        for s in function.statements:
            for m in CALL.finditer(s.bare):
                name = m.group(1)
                if name not in self.functions:
                    continue
                params = self.functions[name][0].params
                for position, (start, end) in enumerate(arguments_of(s.bare, m.end() - 1)):
                    bare = s.bare[start:end]
                    keyword = re.match(r'^\s*(\w+)\s*=(?!=)', bare)
                    if keyword:
                        param = keyword.group(1)
                        start += keyword.end()
                    elif position < len(params) and not bare.lstrip().startswith('*'):
                        param = params[position]
                    else:
                        continue
                    local = s.bare[start:end].strip()
                    if local not in scope.stored | scope.passed or local in scope.callers:
                        continue
                    found = {'stored'} | ({'owner'} if local in scope.owner else set())
                    marks = self.arguments.setdefault(name, {'stored': set(), 'owner': set()})
                    for flag in ('stored', 'owner'):
                        if flag in found and param not in marks[flag]:
                            marks[flag].add(param)
                            grew = True
        return grew

    @staticmethod
    def mark(names, name):
        if name in names:
            return False
        names.add(name)
        return True

    def wraps(self, expression, scope):
        """Is the expression exactly mochi.entity.get(...), a wrapper of it, or
        a local only ever assigned one?"""
        m = re.match(r'^(mochi\.entity\.get|\w+)\s*\(', expression)
        if m and (m.group(1) == 'mochi.entity.get' or m.group(1) in self.wrappers):
            return matching(expression, expression.index('(')) == len(expression)
        if re.match(r'^\w+$', expression):
            return expression in entity_locals(scope.function, self)
        return False

    def reachable(self):
        """Functions a public action can reach, through any reference to an app
        function by name."""
        seen = set()
        pending = [n for n in self.public if n in self.functions]
        while pending:
            name = pending.pop()
            if name in seen:
                continue
            seen.add(name)
            for function in self.functions.get(name, []):
                for word in function.words:
                    if word in self.functions and word not in seen:
                        pending.append(word)
        return seen


def entity_locals(function, app):
    """Locals of a function whose every assignment is exactly a
    mochi.entity.get(...) call or a wrapper of one."""
    assigned = {}
    for s in function.statements:
        m = ASSIGN.match(s.bare)
        if not m or ',' in m.group(1):
            continue
        name = m.group(1).strip()
        expression = s.bare[m.start(2):].strip()
        call = re.match(r'^(mochi\.entity\.get|\w+)\s*\(', expression)
        exact = bool(call and (call.group(1) == 'mochi.entity.get' or call.group(1) in app.wrappers)
                     and matching(expression, expression.index('(')) == len(expression))
        assigned[name] = assigned.get(name, True) and exact
    return {name for name, exact in assigned.items() if exact}


def public_functions(manifest):
    """Function names bound to `public: true` actions in an app manifest."""
    try:
        data = decode(Path(manifest).read_text(encoding='utf-8', errors='replace'))
    except (OSError, ValueError) as problem:
        raise ManifestError(f'{manifest}: could not read app.json: {problem}')
    actions = data.get('actions') if isinstance(data, dict) else None
    names = set()
    if isinstance(actions, dict):
        for action in actions.values():
            if isinstance(action, dict) and action.get('public') is True \
                    and isinstance(action.get('function'), str):
                names.add(action['function'])
    return names


def find_manifest(star_path):
    """The nearest app.json at or above the file's directory, stopping at
    apps/ and at the repository root."""
    # Not resolved: a vendored lib/*.star is a link out of the app, and it
    # belongs to the app it sits in.
    path = Path(star_path) if Path(star_path).is_absolute() else Path.cwd() / star_path
    apps = REPO / 'apps'
    for directory in [path.parent] + list(path.parent.parents):
        if directory == apps:
            return None
        if (directory / 'app.json').is_file():
            return directory / 'app.json'
        if directory == REPO:
            return None
    return None


def app_paths(manifest, star_path):
    """The app's Starlark files: the manifest's execute list and every .star
    below it, the file being checked included."""
    root = manifest.parent
    paths = []
    try:
        listed = decode(manifest.read_text(encoding='utf-8', errors='replace')).get('execute')
    except (OSError, ValueError, AttributeError):
        listed = None
    for relative in listed if isinstance(listed, list) else []:
        if isinstance(relative, str) and (root / relative).is_file():
            paths.append(root / relative)
    paths += [p for p in sorted(root.rglob('*.star')) if p.is_file()]
    paths.append(Path(star_path))
    unique = []
    for p in paths:
        if p not in unique:
            unique.append(p)
    return unique


def app_for(star_path, cache=None):
    """The App a file belongs to, parsed once per manifest when a cache is
    given."""
    star_path = Path(star_path)
    manifest = find_manifest(star_path)
    if manifest is None:
        absolute = star_path if star_path.is_absolute() else Path.cwd() / star_path
        if (REPO / 'apps') in absolute.parents:
            raise ManifestError(f'{star_path}: no app.json above it')
        return App(None, [star_path])
    if cache is not None and manifest in cache:
        app = cache[manifest]
        if star_path not in app.sources:
            app.sources[star_path] = Source(star_path)
        return app
    app = App(manifest, app_paths(manifest, star_path))
    if cache is not None:
        cache[manifest] = app
    return app


# Rule 1: a grant decided by stored ownership. Core's own ownership calls are
# caller-bound and never flagged here; what an anonymous request to a public
# action still substitutes is storage, so `row["owner"] == 1`, a query with
# `owner=1`, or a helper answering from such a read says "owner" for a
# stranger. Scoped to functions a public action can reach: elsewhere the
# storage is the caller's own and the same read answers about them.
def check_stored_grants(app, source):
    out = []
    for function in source.functions:
        if function.name not in app.reach:
            continue
        scope = app.scope(function)
        predicate = bool(ACCESS_FN.match(function.name) or OWNER_NAME.match(function.name))
        for index, s in enumerate(function.statements):
            parts = condition_of(s)
            last = s.last
            if parts:
                if parts[2]:
                    body = parts[2]
                else:
                    following = body_of(function, index)
                    body = following.bare.strip() if following else ''
                    last = following.last if following else s.last
                if not RETURN_TRUE.match(body):
                    continue
                found = scope.flags(parts[0], parts[1])
            elif predicate and RETURN.match(s.bare):
                start = RETURN.match(s.bare).start(1)
                if s.bare[start:].strip() in LITERAL:
                    continue
                found = scope.flags(s.code[start:], s.bare[start:])
            else:
                continue
            if not stored_ownership(found):
                continue
            if guarded(function, index, scope):
                continue
            if source.annotated(s.first, last):
                continue
            out.append((s.first + 1, function.name,
                        'grants on ownership read from storage, which an anonymous '
                        'request reads from the owner: ' + s.text(source)))
    return out


# Rule 2: an access helper that reaches `return True` before any reference to
# the caller. A grant can be spelled with no ownership read at all.
def check_grant_before_caller(app, source):
    out = []
    for function in source.functions:
        if not ACCESS_FN.match(function.name):
            continue
        first_true = None
        first_caller = None
        for j in range(function.start + 1, function.end):
            s = source.code_lines[j].strip()
            if first_true is None and RETURN_TRUE.match(s):
                first_true = j
            # Code only: a comment that merely mentions the user is not the
            # function consulting it.
            if first_caller is None and CALLER.search(source.code_lines[j]):
                first_caller = j
        if first_true is None:
            continue
        if first_caller is not None and first_caller < first_true:
            continue
        if source.annotated_function(function):
            continue
        out.append((first_true + 1, function.name,
                    'grants before consulting the caller: '
                    + source.lines[first_true].strip()))
    return out


# Rule 3: a stored ownership helper consulted in a public action before any
# caller guard. Rule 1 keys on the shape of a grant, so it never sees an
# assignment - and `is_owner = owned(...)` in a public action tells a stranger
# they own it when owned() reads storage. Only the primitives: a predicate
# deciding on stored ownership is reported where it decides, by rule 1.
def check_public_ownership(app, source, reported):
    out = []
    for function in source.functions:
        if function.name not in app.public:
            continue
        scope = app.scope(function)
        for index, s in enumerate(function.statements):
            if not (set(CALL.findall(s.bare)) & app.primitive):
                continue
            if 'caller' in scope.flags(s.code, s.bare) or guarded(function, index, scope):
                break
            if (s.first + 1) in reported:
                break
            if not source.annotated_function(function):
                out.append((s.first + 1, function.name,
                            'ownership read from storage consulted in a public action '
                            'before any caller check: ' + s.text(source)))
            break
    return out


# Rule 4: a helper whose RETURN VALUE is an ownership answer and which takes a
# caller identity it never tests. The identity must be EXERCISED, not merely
# declared; taking one at all is what separates an access predicate from the
# app's own owned()/owned_set() primitives.
def check_owner_predicates(app, source):
    out = []
    for function in source.functions:
        if function.name not in app.ambient:
            continue
        params = [p for p in function.params if CALLER_PARAM.match(p)]
        if not params:
            continue
        body = function.body_code()
        if any(re.search(CALLER_TESTED.format(name=re.escape(p)), b)
               for p in params for b in body):
            continue
        if source.annotated_function(function):
            continue
        out.append((function.start + 1, function.name,
                    'returns an ownership answer but never tests the caller identity '
                    'it takes (%s): %s' % (', '.join(params),
                                           source.lines[function.start].strip())))
    return out


# Rule 5: mochi.entity.get(...) compared with None. The call answers a list -
# empty when the caller does not own the entity - never None, so `!= None` is
# true for everybody and `== None` for nobody.
NONE_AFTER = re.compile(r'^\s*(?:[=!]=\s*None\b|is\s+(?:not\s+)?None\b)')
NONE_BEFORE = re.compile(r'\bNone\s*[=!]=\s*$')


def check_entity_none(app, source):
    out = []
    seen = set()

    def report(offset, function):
        line = source.bare.count('\n', 0, offset)
        if line in seen:
            return
        seen.add(line)
        statement = next((s for s in source.statements if s.first <= line <= s.last), None)
        first, last = (statement.first, statement.last) if statement else (line, line)
        if source.annotated(first, last):
            return
        out.append((line + 1, function or '<module>',
                    'mochi.entity.get() answers a list, never None, so comparing it with '
                    'None is always true or always false; test it as a truth value '
                    '(`if mochi.entity.get(id):`) or ask mochi.entity.owns(id): '
                    + source.lines[line].strip()))

    def enclosing(offset):
        line = source.bare.count('\n', 0, offset)
        inner = None
        for function in source.functions:
            if function.start <= line < function.end:
                inner = function
        return inner

    names = ['mochi.entity.get'] + sorted(app.wrappers)
    pattern = re.compile(r'(?<![\w.])(' + '|'.join(re.escape(n) for n in names) + r')\s*\(')
    for m in pattern.finditer(source.bare):
        opening = source.bare.index('(', m.start())
        close = matching(source.bare, opening)
        before = source.bare[max(0, m.start() - 12):m.start()]
        if NONE_AFTER.match(source.bare[close:]) or NONE_BEFORE.search(before):
            function = enclosing(m.start())
            report(m.start(), function.name if function else None)
    for function in source.functions:
        local = entity_locals(function, app)
        if not local:
            continue
        compare = re.compile(r'(?<![\w.])(' + '|'.join(re.escape(n) for n in sorted(local)) +
                             r')\b(?=\s*(?:[=!]=\s*None\b|is\s+(?:not\s+)?None\b))'
                             r'|\bNone\s*[=!]=\s*(' + '|'.join(re.escape(n) for n in sorted(local)) +
                             r')\b')
        for s in function.statements:
            for m in compare.finditer(s.bare):
                offset = source.offsets[s.first] + s.indent + m.start()
                report(offset, function.name)
    return out


# Rule 6: a whole-table read in a public action. Under the substitution it
# hands an anonymous caller every row of the owner's table - their
# subscriptions, read state or preferences - and nothing about it matches an
# ownership call. A read narrowed by a bound parameter (`where id=?`) is the
# addressed object's, and one made only for a signed-in caller reads their own
# storage. Helpers one level down are followed; deeper ones are not, to keep it
# precise enough to gate.
def check_whole_table_reads(app, source):
    out = []
    reported = set()
    for function in app.every():
        if function.name not in app.public:
            continue
        scope = app.scope(function)
        targets = []
        if function.source is source:
            targets.append((function, None))
        for index, s in enumerate(function.statements):
            for name in set(CALL.findall(s.bare)) & set(app.functions):
                if name == function.name or guarded(function, index, scope):
                    continue
                for helper in app.functions[name]:
                    if helper.source is source:
                        targets.append((helper, function.name))
        for target, via in targets:
            target_scope = app.scope(target)
            for index, s in enumerate(target.statements):
                for m in TABLE_READ.finditer(s.bare):
                    opening = s.bare.index('(', m.start())
                    start, end = first_argument(s.bare, opening)
                    sql = whole_table(s.code[start:end], s.bare[start:end])
                    if not sql:
                        continue
                    if guarded(target, index, target_scope):
                        continue
                    if source.annotated(s.first, s.last):
                        continue
                    key = (s.first, m.start())
                    if key in reported:
                        continue
                    reported.add(key)
                    where = f' (reached from public action {via})' if via else ''
                    out.append((s.first + 1, target.name,
                                'reads a whole table in a public action%s, which hands an '
                                'anonymous caller every row of the owner\'s: %s'
                                % (where, s.text(source))))
    return out


def whole_table(code, bare):
    """The SQL of a read's first argument when it is a literal reading a table
    with no `where` clause binding a parameter; None for anything else,
    including SQL built from variables."""
    literals = re.findall(r'"""(.*?)"""|\'\'\'(.*?)\'\'\'|"((?:[^"\\\n]|\\.)*)"|\'((?:[^\'\\\n]|\\.)*)\'',
                          code, re.S)
    if not literals:
        return None
    # Anything beside literals and `+` is SQL built at run time, which may
    # well bind a parameter: not judged.
    if re.sub(r'[\s"\'+()]', '', bare):
        return None
    sql = ' '.join(next(part for part in groups if part) if any(groups) else '' for groups in literals)
    lower = sql.lower()
    if not re.search(r'\bfrom\s+[a-z_]', lower):
        return None
    where = re.search(r'\bwhere\b', lower)
    if where and '?' in lower[where.end():]:
        return None
    return sql


# Rule 7: in an event handler, an access rule written or removed for the
# event's own sender. The sender is a peer, and the rules are the owner's: an
# unsubscribe that revokes "every rule naming the sender" lets a person the
# owner denied delete their own deny.
def check_sender_access(app, source):
    out = []
    for function in source.functions:
        if not function.name.startswith('event_'):
            continue
        scope = app.scope(function)
        for s in function.statements:
            for m in ACCESS_WRITE.finditer(s.bare):
                opening = s.bare.index('(', m.start())
                start, end = first_argument(s.bare, opening)
                if 'sender' not in scope.flags(s.code[start:end], s.bare[start:end]):
                    continue
                if source.annotated(s.first, s.last):
                    continue
                out.append((s.first + 1, function.name,
                            'changes an access rule for the event\'s own sender, so a peer '
                            'can edit the rules that name it: ' + s.text(source)))
    return out


def check_file(path, cache=None):
    """Findings for one Starlark file, judged with its app's other files."""
    path = Path(path)
    app = app_for(path, cache)
    source = app.sources.get(path) or Source(path)
    findings = check_stored_grants(app, source)
    reported = {line for line, _, _ in findings}
    findings += check_grant_before_caller(app, source)
    findings += check_public_ownership(app, source, reported)
    findings += check_owner_predicates(app, source)
    findings += check_entity_none(app, source)
    findings += check_whole_table_reads(app, source)
    findings += check_sender_access(app, source)
    return findings


def expand(args):
    """Starlark files named by args: directories recursively, globs, files.
    A relative argument is anchored at the repo root, so a run from an app
    directory scans the same tree as one from the root, and every argument
    must name something that exists - a flag or a typo that became a "path"
    used to expand to nothing and pass."""
    paths = []
    for a in args:
        p = Path(a) if Path(a).is_absolute() else REPO / a
        if p.is_dir():
            paths += sorted(p.rglob('*.star'))
        elif any(ch in a for ch in '*?['):
            paths += sorted(REPO.glob(a) if not Path(a).is_absolute() else Path('/').glob(a.lstrip('/')))
        elif p.exists():
            paths.append(p)
        else:
            raise FileNotFoundError(a)
    # apps/test is internal assertions, not user-facing access control - exempt
    # per CLAUDE.md, the same way the i18n and attachment gates treat it.
    return [p for p in paths
            if p.suffix == '.star' and p.is_file() and 'apps/test/' not in p.as_posix()]


def main():
    argv = sys.argv[1:]
    check = '--check' in argv
    argv = [a for a in argv if a != '--check']
    try:
        # Recursive, matching what a directory-scoped run already does.
        files = expand(argv or ['apps'])
    except FileNotFoundError as e:
        print(f'{GATE}: no such path: {e}', file=sys.stderr)
        sys.exit(2)
    files = sorted(set(files))
    if not files:
        print(f'{GATE}: scanned 0 files - nothing was checked', file=sys.stderr)
        sys.exit(2)
    print(f'{GATE}: scanned {len(files)} files', file=sys.stderr)

    cache = {}
    total = 0
    for f in files:
        rel = f.relative_to(REPO) if f.is_relative_to(REPO) else f
        try:
            findings = check_file(f, cache)
        except ManifestError as problem:
            print(f'{GATE}: {problem}', file=sys.stderr)
            sys.exit(2)
        for lineno, func, text in sorted(findings):
            total += 1
            print(f'{rel}:{lineno}: in {func}(): {text}')

    sys.stdout.flush()
    if total:
        print(f'\n{total} finding(s). Decide on the caller (a.user, mochi.entity.owns, '
              f'mochi.access.check) rather than on what the request\'s storage holds, or '
              f'annotate intentional cases with `# access-ok: <reason>`.', file=sys.stderr)
        sys.exit(1 if check else 0)
    else:
        print(f'{GATE}: no findings.')
        sys.exit(0)


if __name__ == '__main__':
    main()
