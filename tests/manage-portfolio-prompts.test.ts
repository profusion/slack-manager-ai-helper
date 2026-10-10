import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import yargs from 'yargs';
import { managePortfolioCommand } from '../src/commands/manage-portfolio.js';
import { runManagePortfolioWizard } from '../src/portfolio/manage-portfolio.js';
import { createManifest, createPromptApi } from './helpers/manage-portfolio.js';

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe('manage-portfolio custom prompts', () => {
  it('adds and saves the canonical prompt reference for a new target', async () => {
    const dir = await makeTempDir();
    const manifestPath = path.join(dir, 'portfolio.json');
    await writeManifest(manifestPath, createManifest());

    await runManagePortfolioWizard(
      { manifest: manifestPath },
      createPromptApi({
        selects: ['add-target', 'plan-reviews', 'save-exit'],
        inputs: ['project-beta', 'Project Beta'],
        confirms: [false, false, false],
      }),
    );

    const saved = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      readonly analyses: readonly {
        readonly targets: readonly {
          readonly id: string;
          readonly additionalPrompts?: readonly string[];
        }[];
      }[];
    };
    expect(saved.analyses[0]?.targets[1]).toMatchObject({
      id: 'project-beta',
      additionalPrompts: ['custom-prompts/project-beta.md'],
    });
    expect(await readFile(path.join(dir, 'custom-prompts/project-beta.md'), 'utf8')).toBe('');
  });

  it('adds the same reference for the first target created with a new analysis', async () => {
    const dir = await makeTempDir();
    const manifestPath = path.join(dir, 'portfolio.json');

    await runManagePortfolioWizard(
      { manifest: manifestPath, createIfMissing: true },
      createPromptApi({
        selects: ['add-analysis', 'save-exit'],
        inputs: ['new-analysis', 'New Analysis', 'project-gamma', 'Project Gamma'],
        confirms: [true, false, false, false],
      }),
    );

    const saved = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      readonly analyses: readonly {
        readonly targets: readonly { readonly additionalPrompts?: readonly string[] }[];
      }[];
    };
    expect(saved.analyses[0]?.targets[0]?.additionalPrompts).toEqual([
      'custom-prompts/project-gamma.md',
    ]);
    expect(await readFile(path.join(dir, 'custom-prompts/project-gamma.md'), 'utf8')).toBe('');
  });

  it('disables new references and all file creation, and creates nothing when discarded', async () => {
    const dir = await makeTempDir();
    const manifestPath = path.join(dir, 'portfolio.json');
    const initial = withCanonicalReferences(createManifest());
    await writeManifest(manifestPath, initial);

    const result = await runManagePortfolioWizard(
      { manifest: manifestPath, createCustomPrompt: false },
      createPromptApi({
        selects: ['add-target', 'plan-reviews', 'save-exit'],
        inputs: ['project-beta', 'Project Beta'],
        confirms: [false, false, false],
      }),
    );
    expect(result.manifest.analyses[0]?.targets[1]?.additionalPrompts).toBeUndefined();
    await expect(
      readFile(path.join(dir, 'custom-prompts/project-alpha.md'), 'utf8'),
    ).rejects.toThrow();
    await expect(
      readFile(path.join(dir, 'custom-prompts/project-beta.md'), 'utf8'),
    ).rejects.toThrow();

    const discardPath = path.join(dir, 'discard.json');
    await writeManifest(discardPath, createManifest());
    const discarded = await runManagePortfolioWizard(
      { manifest: discardPath },
      createPromptApi({
        selects: ['add-target', 'plan-reviews', 'exit'],
        inputs: ['project-gamma', 'Project Gamma'],
        confirms: [false, false, false, true],
      }),
    );
    expect(discarded.saved).toBe(false);
    await expect(
      readFile(path.join(dir, 'custom-prompts/project-gamma.md'), 'utf8'),
    ).rejects.toThrow();
  });

  it('preserves existing content, creates missing canonical files, and ignores other references', async () => {
    const dir = await makeTempDir();
    const manifestPath = path.join(dir, 'portfolio.json');
    const promptsDirectory = path.join(dir, 'custom-prompts');
    await mkdir(promptsDirectory, { recursive: true });
    await writeFile(path.join(promptsDirectory, 'project-alpha.md'), 'keep this prompt');
    const manifest = createManifest();
    const withReferences = {
      ...manifest,
      analyses: manifest.analyses.map((analysis) => ({
        ...analysis,
        targets: [
          ...analysis.targets.map((target) => ({
            ...target,
            additionalPrompts: [`custom-prompts/${target.id}.md`],
          })),
          {
            id: 'project-beta',
            name: 'Project Beta',
            status: 'active',
            additionalPrompts: ['custom-prompts/project-beta.md', 'prompts/arbitrary.md'],
          },
        ],
      })),
    };
    await writeManifest(manifestPath, withReferences);

    await runManagePortfolioWizard(
      { manifest: manifestPath },
      createPromptApi({ selects: ['save-exit'] }),
    );

    expect(await readFile(path.join(promptsDirectory, 'project-alpha.md'), 'utf8')).toBe(
      'keep this prompt',
    );
    expect(await readFile(path.join(promptsDirectory, 'project-beta.md'), 'utf8')).toBe('');
    await expect(readFile(path.join(dir, 'prompts/arbitrary.md'), 'utf8')).rejects.toThrow();
  });

  it('preserves a canonical symlink to a regular prompt file', async () => {
    const dir = await makeTempDir();
    const manifestPath = path.join(dir, 'portfolio.json');
    const promptsDirectory = path.join(dir, 'custom-prompts');
    const sourcePath = path.join(dir, 'source.md');
    const canonicalPath = path.join(promptsDirectory, 'project-alpha.md');
    await mkdir(promptsDirectory, { recursive: true });
    await writeFile(sourcePath, 'linked prompt');
    await symlink(sourcePath, canonicalPath);
    await writeManifest(manifestPath, withCanonicalReferences(createManifest()));

    await runManagePortfolioWizard(
      { manifest: manifestPath },
      createPromptApi({ selects: ['save-exit'] }),
    );

    expect((await lstat(canonicalPath)).isSymbolicLink()).toBe(true);
    expect((await stat(canonicalPath)).isFile()).toBe(true);
    expect(await readFile(canonicalPath, 'utf8')).toBe('linked prompt');
  });

  it('does not save the manifest when a canonical prompt path is a directory', async () => {
    const dir = await makeTempDir();
    const manifestPath = path.join(dir, 'portfolio.json');
    const manifest = withCanonicalReferences(createManifest());
    const original = `${JSON.stringify(manifest, null, 2)}\n`;
    await writeFile(manifestPath, original);
    await mkdir(path.join(dir, 'custom-prompts/project-alpha.md'), { recursive: true });

    await expect(
      runManagePortfolioWizard(
        { manifest: manifestPath },
        createPromptApi({ selects: ['save-exit'] }),
      ),
    ).rejects.toThrow('Canonical custom prompt path is not a file');

    expect(await readFile(manifestPath, 'utf8')).toBe(original);
    expect((await readdir(dir)).some((file) => file.endsWith('.bak'))).toBe(false);
  });

  it('defaults custom prompt creation on and parses --no-create-custom-prompt', async () => {
    const builder = managePortfolioCommand.builder;
    if (typeof builder !== 'function') {
      throw new Error('manage-portfolio command has no option builder');
    }
    const parseOptions = async (args: string[]) =>
      (await builder(yargs())).parseAsync(['--manifest', 'portfolio.json', ...args]);

    expect(await parseOptions([])).toMatchObject({ createCustomPrompt: true });
    expect(await parseOptions(['--no-create-custom-prompt'])).toMatchObject({
      createCustomPrompt: false,
    });
  });
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'smah-manage-portfolio-prompts-'));
  tempDirs.push(dir);
  return dir;
}

async function writeManifest(manifestPath: string, manifest: unknown): Promise<void> {
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

function withCanonicalReferences(manifest: ReturnType<typeof createManifest>) {
  return {
    ...manifest,
    analyses: manifest.analyses.map((analysis) => ({
      ...analysis,
      targets: analysis.targets.map((target) => ({
        ...target,
        additionalPrompts: [`custom-prompts/${target.id}.md`],
      })),
    })),
  };
}
