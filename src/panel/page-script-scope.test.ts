// The page script is one function. A helper pasted into another function's body still parses and passes every
// other test, but a top-level listener that calls it throws "is not defined" on click (2026-10-16: the version
// popover did nothing in the Portal). This checks that every function a top-level listener calls is in the top scope.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { runInNewContext } from 'node:vm'
import { PAGE_SCRIPT } from './page-script.ts'

describe('page script scope', () => {
  it('defines every function a top-level listener calls in the top scope', () => {
    // Function declarations are hoisted, so at the first line of the outer function every top-level one exists; the
    // probe answers there and the rest of the script (which needs a real page) never runs.
    const head = "(() => {\n  'use strict'\n"
    assert.ok(PAGE_SCRIPT.startsWith(head))
    const probe =
      'globalThis.inScope = (n) => { try { return typeof eval(n) === "function" } catch { return false } }; return\n'
    const ctx: { inScope?: (name: string) => boolean } = {}
    runInNewContext(head + probe + PAGE_SCRIPT.slice(head.length), ctx)
    // Top-level statements are indented two spaces; the handler is a bare name (`, openUpdate)`) or an arrow whose
    // body starts with a call (`() => openVerPop($('ver'))`).
    const called = [
      ...PAGE_SCRIPT.matchAll(/^ {2}\S.*addEventListener\('[a-z]+', ([A-Za-z_$][\w$]*)\)/gm),
      ...PAGE_SCRIPT.matchAll(
        /^ {2}\S.*addEventListener\('[a-z]+', \([^)]*\) => \{? *([A-Za-z_$][\w$]*)\(/gm,
      ),
    ].map((m) => m[1]!)
    assert.ok(called.length > 5, `found the top-level listeners (${called.length})`)
    assert.deepEqual(
      called.filter((name) => !ctx.inScope!(name)),
      [],
      'these are called by a top-level listener but are not functions in the top scope',
    )
  })
})
