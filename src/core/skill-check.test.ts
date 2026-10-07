import assert from 'node:assert/strict'
import { mkdir, symlink } from 'node:fs/promises'
import { describe, it } from 'node:test'
import { type FakeHome, withFakeHome } from '../../testing/index.ts'
import { createRuntime } from '../runtime.ts'
import { skillVersionOf } from './skill-check.ts'
import { packageVersion } from './version.ts'

const skill = (version?: string) =>
  `---\nname: sideby\ndescription: test\n${version ? `metadata:\n  version: "${version}"\n` : ''}---\n\n# sideby\n`

async function claudeMain(h: FakeHome) {
  await h.write('.claude/settings.json', '{}\n')
}

describe('skillVersionOf', () => {
  it('reads metadata.version from the frontmatter only', () => {
    assert.equal(skillVersionOf(skill('1.2.3')), '1.2.3')
    assert.equal(skillVersionOf("---\nname: x\nmetadata:\n  author: a\n  version: '0.2.0'\n---\n"), '0.2.0')
    assert.equal(skillVersionOf(skill()), null)
    assert.equal(
      skillVersionOf('---\nname: x\n---\nmetadata:\n  version: 9.9.9\n'),
      null,
      'body text does not count',
    )
    assert.equal(skillVersionOf('no frontmatter'), null)
  })
})

describe('doctor and the installed skill', () => {
  it('warns once about an outdated skill, linked or not, and still exits healthy', async () => {
    await withFakeHome(async (h) => {
      await claudeMain(h)
      await h.write('.agents/skills/sideby/SKILL.md', skill('0.0.1'))
      await mkdir(h.path('.claude/skills'), { recursive: true })
      await symlink(h.path('.agents/skills/sideby'), h.path('.claude/skills/sideby'))
      const report = await (await createRuntime({ env: h.env })).doctor({ persist: false })
      const found = report.general.filter((f) => f.code === 'skill.outdated')
      assert.equal(found.length, 1, 'the link and its target are one skill')
      assert.equal(found[0]!.level, 'warn')
      assert.equal(found[0]!.account, 'claude:main')
      assert.match(found[0]!.message, /for sideby 0\.0\.1; this sideby is/)
      assert.match(found[0]!.hint ?? '', /npx skills add Adonis0123\/sideby -g/)
      assert.equal(report.status, 'ok', 'a warning alone keeps doctor healthy')
    })
  })

  it('says nothing when the skill matches this version, is not installed, or doctor checks one account', async () => {
    await withFakeHome(async (h) => {
      await claudeMain(h)
      const rt = async () => createRuntime({ env: h.env })
      const codes = async (target?: string) =>
        (await (await rt()).doctor({ persist: false, ...(target ? { target } : {}) })).general.map(
          (f) => f.code,
        )
      assert.deepEqual(await codes(), [])
      await h.write('.claude/skills/sideby/SKILL.md', skill(packageVersion()))
      assert.deepEqual(await codes(), [])
      await h.write('.claude/skills/sideby/SKILL.md', skill())
      assert.deepEqual(await codes(), ['skill.outdated'])
      assert.deepEqual(await codes('claude:main'), ['skill.outdated'], 'one account checks its family too')
    })
  })

  it('gives each family its own view, whichever families one run checks', async () => {
    await withFakeHome(async (h) => {
      await claudeMain(h)
      await h.write('.codex/config.toml', 'model = "m"\n')
      await h.write('.codex/AGENTS.md', '# rules\n')
      await h.write('.agents/skills/sideby/SKILL.md', skill('0.0.1'))
      await mkdir(h.path('.claude/skills'), { recursive: true })
      await symlink(h.path('.agents/skills/sideby'), h.path('.claude/skills/sideby'))
      const rt = await createRuntime({ env: h.env })
      const owners = async (target?: string) =>
        (await rt.doctor({ persist: false, ...(target ? { target } : {}) })).general
          .filter((f) => f.code === 'skill.outdated')
          .map((f) => `${f.account} ${f.item}`)
      // Claude reads ~/.claude/skills (a link here), Codex reads ~/.agents/skills: one file, two Hosts.
      assert.deepEqual(await owners(), [
        'claude:main ~/.claude/skills/sideby/SKILL.md',
        'codex:main ~/.agents/skills/sideby/SKILL.md',
      ])
      assert.deepEqual(await owners('codex'), ['codex:main ~/.agents/skills/sideby/SKILL.md'])
      assert.deepEqual(await owners('claude'), ['claude:main ~/.claude/skills/sideby/SKILL.md'])
    })
  })

  it('keeps the saved skill warning when doctor then checks one account', async () => {
    await withFakeHome(async (h) => {
      await claudeMain(h)
      await h.write('.claude/skills/sideby/SKILL.md', skill('0.0.1'))
      const rt = await createRuntime({ env: h.env })
      await rt.doctor()
      await rt.doctor({ target: 'claude:main' })
      const saved = (await rt.doctorHistory())?.general.claude?.findings.map((f) => f.code)
      assert.deepEqual(saved, ['skill.outdated'])
    })
  })
})
