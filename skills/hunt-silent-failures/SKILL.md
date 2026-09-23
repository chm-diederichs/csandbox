---
name: hunt-silent-failures
description: Targeted hunt for code paths that fail without anyone learning about it - swallowed errors, defaults that mask failure, unobserved rejections, streams and emitters that drop errors, timeouts that resolve. Use when a bug reproduces intermittently with no error, when auditing a module before relying on it, or as a read-only subagent brief over lib/. Do not use as a general code review; pair with strict-review for that.
---

# Hunt silent failures

A silent failure is one where the caller never learns something went wrong.
In an evented, streaming, replicated codebase those hide in the plumbing, not
the logic. The question for every candidate is the same: **does anyone
upstream ever find out?**

## Where they hide

**Generic**
- Empty `catch {}` / `catch (e) {}` with no rethrow, log, or state change.
- Errors converted to `null`, `false`, `[]`, `0` and returned as if data.
- `.catch(() => {})`, `.catch(noop)`, `.catch(() => defaultValue)` where the
  caller then proceeds on the default.
- A default parameter or `|| fallback` that turns a missing *required* value
  into a plausible one.
- Rethrow that drops the original: `throw new Error('failed')` losing `cause`
  and the stack.
- A missing `await` inside `try`, so the `catch` can never fire.
- Loops that `continue` on error and report success at the end.

**Streams / emitters / replication**
- `'error'` listener that is a noop or only `console.error` - the stream is
  now "handled" and nothing above it knows.
- Emitters with no `'error'` listener at all - one emitted error crashes the
  process, or, if wrapped, vanishes.
- `stream.destroy()` called without the error, so `pipeline` / the peer side
  sees a clean close instead of a failure.
- `'close'` handled but `'error'` not, or the reverse, so one path leaks.
- `safety-catch`-style patterns that convert a rejection into a later throw
  nobody awaits.
- `session.close()` / `core.close()` racing an in-flight `get()` / `append()`:
  the op resolves with stale data or never resolves.
- Timeouts that **resolve** (with `null`, `false`) instead of rejecting.
- Retry loops with no cap or with a cap that exits silently.
- Backpressure ignored: `write()` return value unchecked, unbounded queues.

## Procedure

1. Scope: `lib/`, `index.js`, and any file the task names. Skip `test/`
   unless asked (test helpers that swallow are a separate class).
2. Grep the shapes, then read each hit in context: `catch`, `.catch(`,
   `'error'`, `destroy(`, `setTimeout`, `|| `, `?? `, `noop`.
3. For each hit answer: what fails here, and who learns? If the answer is
   "nobody" or "a log line", it is a finding.
4. Rate by consequence, not by shape: HIGH if the caller continues with wrong
   state or data, or a resource is left open; MEDIUM if it is surfaced late or
   only as a log; LOW if it is a deliberate best-effort path *and* commented.
5. Confirm deliberate ones before flagging - a comment or a `void` prefix
   usually says so. Do not flag those; list them separately as "intentional".

## Output

```
| file:line | severity | what fails | who learns (today) | fix |
|-----------|----------|------------|--------------------|-----|

Intentional (comment/void present, left alone):
- file:line - why it is fine
```

Fixes are one line: "reject instead of resolve(null)", "destroy(err) not
destroy()", "rethrow with { cause }", "add 'error' listener that propagates to
the session". Do not edit files when run as a subagent.
