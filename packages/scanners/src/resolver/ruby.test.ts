import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseGemfileLock, readGemfileGroups } from './ruby'
import type { ResolverResult } from './types'

// Gemfile.lock is the whole resolved set, so Ruby resolves `ok` — unless a gem comes from a git checkout or
// a local path outside the project, which no advisory database covers. The cases below pin both halves of
// what could go quietly wrong: a gem matched that should not be (a GIT gem compared against RubyGems
// advisories), and a dev gem shown as prod or the other way round.

let dir: string

beforeEach(async function setup() {
    dir = await mkdtemp(join(tmpdir(), 'sentinello-ruby-'))
})

afterEach(async function cleanup() {
    await rm(dir, { recursive: true, force: true })
})

async function write(name: string, text: string): Promise<string> {
    const path = join(dir, name)
    await writeFile(path, text, 'utf8')
    return path
}

async function parse(lock: string, gemfile: string | null = null): Promise<ResolverResult> {
    if (gemfile !== null) await write('Gemfile', gemfile)
    return await parseGemfileLock(dir, await write('Gemfile.lock', lock), 'Gemfile.lock')
}

function names(result: ResolverResult): string[] {
    if (result.status === 'unauditable') return []
    return result.graph.packages.map(function name(p) { return p.name }).sort()
}

// Shaped like a Rails app's lockfile: one gem server, a platform-specific native gem, a dev/test group.
const LOCK = `GEM
  remote: https://rubygems.org/
  specs:
    actionpack (7.1.3)
      rack (>= 2.2.4)
      rails-html-sanitizer (~> 1.6)
    nokogiri (1.16.0-arm64-darwin)
      racc (~> 1.4)
    nokogiri (1.16.0-x86_64-linux)
      racc (~> 1.4)
    racc (1.7.3)
    rack (2.2.8)
    rails-html-sanitizer (1.6.0)
      nokogiri (~> 1.14)
    rspec-core (3.13.0)
      rspec-support (~> 3.13.0)
    rspec-support (3.13.1)

PLATFORMS
  arm64-darwin-23
  x86_64-linux

DEPENDENCIES
  actionpack (~> 7.1)
  rspec-core

BUNDLED WITH
   2.5.4
`

const GEMFILE = `source "https://rubygems.org"

gem "actionpack", "~> 7.1"

group :development, :test do
  gem "rspec-core"
end
`

describe('parseGemfileLock', function () {
    it('reads every locked gem once, platform suffix stripped', async function () {
        const result = await parse(LOCK)
        expect(result.status).toBe('ok')
        expect(names(result)).toEqual(['actionpack', 'nokogiri', 'racc', 'rack', 'rails-html-sanitizer', 'rspec-core', 'rspec-support'])
        expect(result.status !== 'unauditable' && result.graph.byName('nokogiri').map(function v(p) { return p.version })).toEqual(['1.16.0'])
    })

    it('gives each gem its shortest chain from the Gemfile', async function () {
        const result = await parse(LOCK)
        if (result.status === 'unauditable') throw new Error('expected a graph')
        expect(result.graph.byName('racc')[0]?.depPaths).toEqual(['actionpack@7.1.3', 'rails-html-sanitizer@1.6.0', 'nokogiri@1.16.0', 'racc@1.7.3'])
        expect(result.graph.byName('racc')[0]?.manifestPath).toBe('Gemfile.lock')
    })

    // The Gemfile's groups are the roots' scope, spread through the graph.
    it('spreads the Gemfile groups through the graph', async function () {
        const result = await parse(LOCK, GEMFILE)
        if (result.status === 'unauditable') throw new Error('expected a graph')
        expect(result.graph.classify('rspec-support', '3.13.1')).toMatchObject({ isProd: false, isDev: true })
        expect(result.graph.classify('racc', '1.7.3')).toMatchObject({ isProd: true, isDev: false })
    })

    // With no Gemfile to read, everything is prod: over-reporting, never under-reporting.
    it('treats every gem as prod with no Gemfile', async function () {
        const result = await parse(LOCK)
        if (result.status === 'unauditable') throw new Error('expected a graph')
        expect(result.graph.classify('rspec-support', '3.13.1')).toMatchObject({ isProd: true, isDev: false })
    })

    // A GIT gem is someone's checkout, not the release of that name: counted, never matched. What it depends
    // on still comes from the gem server, and is still reached.
    it('counts a git gem as cannot be audited and still reaches what it depends on', async function () {
        const lock = `GIT
  remote: https://github.com/example/rails.git
  revision: 0123456789abcdef
  branch: main
  specs:
    rails (7.2.0.alpha)
      rack (>= 2.2.4)

GEM
  remote: https://rubygems.org/
  specs:
    rack (2.2.8)

DEPENDENCIES
  rails!
`
        const result = await parse(lock)
        expect(result.status).toBe('partial')
        expect(names(result)).toEqual(['rack'])
        expect(result.status === 'partial' && result.reasonCode).toBe('partial_dependency_graph')
        expect(result.status === 'partial' && result.details.join(' ')).toContain('rails (git)')
        expect(result.status === 'partial' && result.graph.byName('rack')[0]?.depPaths).toEqual(['rails@7.2.0.alpha', 'rack@2.2.8'])
    })

    // `remote: .` is the gem the project develops — its own code, not a dependency.
    it('treats a PATH gem inside the project as the project itself', async function () {
        await mkdir(join(dir, 'engines', 'admin'), { recursive: true })
        const lock = `PATH
  remote: .
  specs:
    my_gem (0.1.0)
      rack (>= 2)

PATH
  remote: engines/admin
  specs:
    admin (0.1.0)

GEM
  remote: https://rubygems.org/
  specs:
    rack (2.2.8)

DEPENDENCIES
  admin!
  my_gem!
`
        const result = await parse(lock)
        expect(result.status).toBe('ok')
        expect(names(result)).toEqual(['rack'])
    })

    it('counts a PATH gem outside the project as cannot be audited', async function () {
        const lock = `PATH
  remote: ../shared/vendored
  specs:
    vendored (1.0.0)

GEM
  remote: https://rubygems.org/
  specs:
    rack (2.2.8)

DEPENDENCIES
  rack
  vendored!
`
        const result = await parse(lock)
        expect(result.status).toBe('partial')
        expect(result.status === 'partial' && result.details.join(' ')).toContain('vendored (path)')
    })

    it('is unauditable when only git gems are locked', async function () {
        const lock = 'GIT\n  remote: https://github.com/example/x.git\n  specs:\n    x (1.0.0)\n\nDEPENDENCIES\n  x!\n'
        const result = await parse(lock)
        expect(result.status).toBe('unauditable')
        expect(result.status === 'unauditable' && result.reasonCode).toBe('ambiguous_dependency_spec')
    })

    it('is unauditable when no gems are locked', async function () {
        const result = await parse('DEPENDENCIES\n  rack\n\nBUNDLED WITH\n   2.5.4\n')
        expect(result.status).toBe('unauditable')
        expect(result.status === 'unauditable' && result.details.join(' ')).toContain('no gems found')
    })

    it('is unauditable when the lockfile cannot be read', async function () {
        const result = await parseGemfileLock(dir, join(dir, 'missing.lock'), 'Gemfile.lock')
        expect(result).toEqual({ status: 'unauditable', ecosystem: 'RubyGems', reasonCode: 'unsupported_lockfile', details: ['could not read Gemfile.lock'] })
    })

    it('ignores the sections that carry no gems, and a root with nothing locked', async function () {
        const lock = LOCK.replace('BUNDLED WITH', 'CHECKSUMS\n  rack (2.2.8) sha256=abc\n\nRUBY VERSION\n   ruby 3.3.0p0\n\nBUNDLED WITH').replace('  rspec-core\n', '  rspec-core\n  missing-gem\n')
        expect(names(await parse(lock))).toHaveLength(7)
    })

    it('handles CRLF line endings', async function () {
        expect(names(await parse(LOCK.replace(/\n/g, '\r\n')))).toHaveLength(7)
    })
})

describe('readGemfileGroups', function () {
    async function devGems(gemfile: string): Promise<string[]> {
        return [...await readGemfileGroups(await write('Gemfile', gemfile))].sort()
    }

    it('reads a group block and an inline group option, in every spelling', async function () {
        const gemfile = `gem "rails"
group :development, :test do
  gem "rspec-rails" # tests
  gem("factory_bot")
end
gem "debug", group: :development
gem "web-console", groups: [:development]
gem "capybara", :group => "test"
gem "puma", group: :production
`
        expect(await devGems(gemfile)).toEqual(['capybara', 'debug', 'factory_bot', 'rspec-rails', 'web-console'])
    })

    // A group other than development or test is installed by default and ships with the app.
    it('reads any other group as prod', async function () {
        expect(await devGems('group :assets do\n  gem "sass"\nend\ngroup :development, :assets do\n  gem "x"\nend\n')).toEqual([])
    })

    // Declared both ways, the gem ships.
    it('keeps a gem declared in prod and in a dev group as prod', async function () {
        expect(await devGems('gem "pry"\ngroup :development do\n  gem "pry"\nend\n')).toEqual([])
    })

    // Blocks that are not groups still close with `end`, so the group they sit in is not lost.
    it('tracks non-group blocks inside and around a group', async function () {
        const gemfile = `source "https://gems.example.test" do
  gem "private-gem"
end
group :test do
  platforms :ruby do
    gem "sqlite3"
  end
  if ENV["CI"]
    gem "ci-reporter"
  end
  gem "webmock"
end
gem "rack"
`
        expect(await devGems(gemfile)).toEqual(['ci-reporter', 'sqlite3', 'webmock'])
    })

    it('reads keyword options after the groups as options, not groups', async function () {
        expect(await devGems('group :development, :test, optional: true do\n  gem "x"\nend\n')).toEqual(['x'])
    })

    it('opens a block for a gem declared with one', async function () {
        expect(await devGems('group :test do\n  gem "x", git: "https://example.test/x.git" do\n  end\n  gem "y"\nend\n')).toEqual(['x', 'y'])
    })

    it('reads nothing from a Gemfile that cannot be read', async function () {
        expect([...await readGemfileGroups(join(dir, 'missing'))]).toEqual([])
    })
})

describe('parseGemfileLock — lines it does not model', function () {
    // A dependency of a locked gem that is not locked itself, and a DEPENDENCIES line in no shape Bundler
    // writes, are skipped rather than guessed at.
    it('skips a dependency with nothing locked and an unrecognised root line', async function () {
        const lock = 'GEM\n  remote: https://rubygems.org/\n  specs:\n    rack (2.2.8)\n      missing (>= 1)\n\nDEPENDENCIES\n  rack\n    stray nested line\n'
        const result = await parse(lock)
        expect(names(result)).toEqual(['rack'])
        expect(result.status !== 'unauditable' && result.graph.nodeGraph?.edges).toEqual([])
    })

    it('reads a group with no symbols as no group', async function () {
        expect([...await readGemfileGroups(await write('Gemfile', 'group () do\n  gem "x"\nend\n'))]).toEqual([])
    })
})
