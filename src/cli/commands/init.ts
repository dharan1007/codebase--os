import { Command } from 'commander';
import path from 'path';
import fs from 'fs';
import inquirer from 'inquirer';
import chalk from 'chalk';
import ora from 'ora';
import yaml from 'yaml';
import { ProjectConfigSchema, type ProjectConfig } from '../../types/index.js';
import { AIProviderFactory } from '../../core/ai/AIProviderFactory.js';
import { logger } from '../../utils/logger.js';
import { listPresets, getPreset, type PresetName } from '../../core/presets/ProjectPresets.js';
import { EnvEditor } from '../../utils/EnvEditor.js';

export function initCommand(): Command {
    return new Command('init')
        .description('Initialize Codebase OS in the current project')
        .option('-y, --yes', 'Use defaults without prompting')
        .option('--provider <provider>', 'AI provider (openai|anthropic|gemini|openrouter|ollama)')
        .option('--preset <preset>', 'Project preset (nextjs|react|react-native|flutter|android-kotlin|ios-swift|django|fastapi|express|spring-boot|laravel|rails|generic)')
        .action(async (opts: any) => {
            const rootDir = process.cwd();
            const cosDir = path.join(rootDir, '.cos');

            if (fs.existsSync(path.join(cosDir, 'config.yaml')) && !opts.yes) {
                const { overwrite } = await inquirer.prompt([{
                    type: 'confirm', name: 'overwrite',
                    message: 'Codebase OS is already initialized. Overwrite configuration?',
                    default: false,
                }]);
                if (!overwrite) {
                    console.log(chalk.yellow('Initialization cancelled.'));
                    return;
                }
            }

            const pkgJson = path.join(rootDir, 'package.json');
            const defaultName = fs.existsSync(pkgJson)
                ? (JSON.parse(fs.readFileSync(pkgJson, 'utf8')) as { name?: string }).name ?? path.basename(rootDir)
                : path.basename(rootDir);

            const availableProviders = await AIProviderFactory.detectAvailableProviders();

            // Resolve preset if specified or prompt for one
            let presetName: PresetName | null = opts.preset as PresetName ?? null;

            if (!opts.yes && !presetName) {
                const presets = listPresets();
                const { selectedPreset } = await inquirer.prompt([{
                    type: 'list',
                    name: 'selectedPreset',
                    message: 'Select project type:',
                    choices: presets.map(p => ({
                        name: `${p.displayName} — ${p.description}`,
                        value: p.name,
                    })),
                    default: 'generic',
                }]);
                presetName = selectedPreset as PresetName;
            }

            const preset = presetName ? getPreset(presetName) : null;

            let answers: any = {};
            if (opts.yes) {
               answers = {
                   name: defaultName,
                   language: preset?.language ?? 'typescript',
                   provider: opts.provider ?? preset?.ai.provider ?? availableProviders[0] ?? 'anthropic',
               };
            } else {
               // In interactive mode, we always ask for these to be sure
               answers = await inquirer.prompt([
                   { type: 'input', name: 'name', message: 'Project name:', default: defaultName },
                   {
                       type: 'list', name: 'language', message: 'Primary language:',
                       choices: ['typescript', 'javascript', 'python', 'go', 'kotlin', 'swift', 'dart', 'ruby', 'php', 'java', 'csharp', 'mixed'],
                       default: preset?.language ?? 'typescript',
                   },
                   {
                       type: 'list', name: 'provider', message: 'Primary AI provider:',
                       choices: ['openai', 'anthropic', 'gemini', 'openrouter', 'ollama'],
                       default: preset?.ai.provider ?? availableProviders[0] ?? 'anthropic',
                   },
               ]);
            }

            // Production-Grade AI Configuration Section
            const aiConfigs: Record<string, { model: string; key?: string; url?: string }> = {};
            const providersToConfigure = [answers.provider];

            if (!opts.yes) {
                console.log(chalk.bold('\nAI Configuration — Production Settings'));
                console.log(chalk.gray('─'.repeat(40)));

                // Use a standard counter loop to allow pushing new items during iteration
                for (let i = 0; i < providersToConfigure.length; i++) {
                    const provider = providersToConfigure[i];
                    const isBackup = i > 0;

                    console.log(`\nConfiguring ${chalk.bold(provider.toUpperCase())}${isBackup ? ' (BACKUP)' : ''}:`);
                    
                    const configSet: any = { model: '' };

                    // 1. Prompt for API Key / URL
                    if (provider !== 'ollama') {
                        const envKey = `${provider.toUpperCase()}_API_KEY`;
                        const existingKey = process.env[envKey];
                        const { key } = await inquirer.prompt([{
                            type: 'password',
                            name: 'key',
                            message: `Enter ${provider.toUpperCase()} API Key${existingKey ? ' (leave blank to keep current)' : ''}:`,
                            mask: '*',
                        }]);
                        if (key || existingKey) configSet.key = key || existingKey;
                    } else {
                        const { url } = await inquirer.prompt([{
                            type: 'input',
                            name: 'url',
                            message: 'Ollama Base URL:',
                            default: process.env['OLLAMA_BASE_URL'] ?? 'http://localhost:11434',
                        }]);
                        configSet.url = url;
                    }

                    // 2. Prompt for Model Selection
                    const modelRecommendations: Record<string, string[]> = {
                        openai: ['gpt-4o', 'gpt-4-turbo', 'gpt-3.5-turbo'],
                        anthropic: ['claude-3-5-sonnet-20241022', 'claude-3-opus-20240229', 'claude-3-haiku-20240307'],
                        gemini: ['gemini-1.5-pro', 'gemini-1.5-flash'],
                        openrouter: ['anthropic/claude-3.5-sonnet', 'openai/gpt-4o', 'google/gemini-pro-1.5'],
                        ollama: ['codellama:34b', 'llama3', 'mistral', 'phi3'],
                    };

                    const { modelType } = await inquirer.prompt([{
                        type: 'list',
                        name: 'modelType',
                        message: `Select model for ${provider}:`,
                        choices: [
                            ...modelRecommendations[provider as keyof typeof modelRecommendations].map(m => ({ name: m, value: m })),
                            { name: 'Custom model string...', value: 'custom' }
                        ],
                        default: isBackup ? modelRecommendations[provider as keyof typeof modelRecommendations][0] : (preset?.ai.model ?? modelRecommendations[provider as keyof typeof modelRecommendations][0])
                    }]);

                    if (modelType === 'custom') {
                        const { customModel } = await inquirer.prompt([{
                            type: 'input',
                            name: 'customModel',
                            message: 'Enter custom model name:',
                        }]);
                        configSet.model = customModel;
                    } else {
                        configSet.model = modelType;
                    }

                    aiConfigs[provider] = configSet;

                    // 3. Ask if they want to configure backup providers (only once)
                    if (i === 0) {
                        const { addMore } = await inquirer.prompt([{
                            type: 'confirm',
                            name: 'addMore',
                            message: 'Would you like to configure backup AI providers?',
                            default: false,
                        }]);
                        if (addMore) {
                            const { others } = await inquirer.prompt([{
                                type: 'checkbox',
                                name: 'others',
                                message: 'Select additional providers to configure:',
                                choices: ['openai', 'anthropic', 'gemini', 'openrouter', 'ollama'].filter(p => p !== provider),
                            }]);
                            providersToConfigure.push(...others);
                        }
                    }
                }
            } else {
                // Default settings for automated mode
                aiConfigs[answers.provider] = {
                    model: preset?.ai.model ?? 'default',
                    key: process.env[`${answers.provider.toUpperCase()}_API_KEY`]
                };
            }

            const config: ProjectConfig = ProjectConfigSchema.parse({
                name: answers.name || defaultName,
                version: '1.0.0',
                rootDir,
                language: answers.language as ProjectConfig['language'],
                layers: preset ? {
                    database: preset.layers.database,
                    backend: preset.layers.backend,
                    api: preset.layers.api,
                    frontend: preset.layers.frontend,
                } : {
                    database: [fs.existsSync(path.join(rootDir, 'src/db')) ? 'src/db' : 'db'],
                    backend: ['src'],
                    api: ['src/routes', 'src/api', 'src/controllers'],
                    frontend: [fs.existsSync(path.join(rootDir, 'src/client')) ? 'src/client' : 'src/web'],
                },
                exclude: preset?.exclude ?? ['node_modules', 'dist', '.git', '.cos', 'coverage', '.next', '.nuxt', '__pycache__'],
                ai: {
                    provider: answers.provider as ProjectConfig['ai']['provider'],
                    model: aiConfigs[answers.provider]?.model,
                    temperature: 0.2,
                    maxTokens: 4096,
                },
                environment: {
                    autoResolvePortConflicts: true,
                    autoResolveRuntimeVersions: true,
                    dockerSocket: '/var/run/docker.sock',
                },
                watch: {
                    debounceMs: 500,
                    autoAnalyze: true,
                    autoApply: false,
                },
            });

            const spinner = ora('Saving production configuration...').start();

            if (!fs.existsSync(cosDir)) {
                fs.mkdirSync(cosDir, { recursive: true });
            }

            // Save Credentials to .env via EnvEditor
            const envUpdates: Record<string, string> = {};
            for (const [p, cfg] of Object.entries(aiConfigs)) {
                if (cfg.key) envUpdates[`${p.toUpperCase()}_API_KEY`] = cfg.key;
                if (cfg.url) envUpdates['OLLAMA_BASE_URL'] = cfg.url;
            }
            EnvEditor.update(rootDir, envUpdates);

            const configPath = path.join(cosDir, 'config.yaml');
            fs.writeFileSync(configPath, yaml.stringify(config), 'utf8');

            const envExamplePath = path.join(rootDir, '.env.example');
            if (!fs.existsSync(envExamplePath)) {
                const envContent = [
                    '# Codebase OS — AI Provider Keys',
                    'OPENAI_API_KEY=',
                    'ANTHROPIC_API_KEY=',
                    'GEMINI_API_KEY=',
                    'OPENROUTER_API_KEY=',
                    'OLLAMA_BASE_URL=http://localhost:11434',
                    '',
                    `COS_DEFAULT_PROVIDER=${config.ai.provider}`,
                    'COS_LOG_LEVEL=info',
                ].join('\n');
                fs.writeFileSync(envExamplePath, envContent, 'utf8');
            }

            const gitignorePath = path.join(rootDir, '.gitignore');
            if (fs.existsSync(gitignorePath)) {
                const content = fs.readFileSync(gitignorePath, 'utf8');
                let newContent = content;
                const ignores = ['.env', '.cos/cos.db', '.cos/snapshots/', '.cos/*.log'];
                for (const ig of ignores) {
                    if (!content.includes(ig)) {
                        newContent += `\n${ig}`;
                    }
                }
                if (newContent !== content) {
                    fs.writeFileSync(gitignorePath, newContent, 'utf8');
                }
            }

            spinner.succeed(chalk.green('Codebase OS initialized for production!'));

            console.log('');
            console.log(chalk.cyan('Next steps:'));
            console.log(`  ${chalk.bold('cos scan')}     — Build the relationship graph`);
            console.log(`  ${chalk.bold('cos watch')}    — Monitor impact in real-time`);
            console.log(`  ${chalk.bold('cos ask')}      — Let AI build features for you`);
            console.log('');
            console.log(chalk.gray(`Config saved to: ${configPath}`));
        });
}