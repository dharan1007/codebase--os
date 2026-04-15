import { Command } from 'commander';
import chalk from 'chalk';
import inquirer from 'inquirer';
import ora from 'ora';
import { loadContext } from '../context.js';
import { AIProviderFactory } from '../../core/ai/AIProviderFactory.js';
import { EnvEditor } from '../../utils/EnvEditor.js';
import { logger } from '../../utils/logger.js';
import type { AIProviderKind } from '../../types/index.js';

export function configCommand(): Command {
    return new Command('config')
        .description('Interactively update AI provider, model, or API keys')
        .action(async () => {
            const ctx = await loadContext();
            if (!ctx) return;

            const { config, db, rootDir } = ctx;

            console.log(chalk.bold('\nCodebase OS — Configuration Manager'));
            console.log(chalk.gray('─'.repeat(40)));
            console.log(`  Current Provider: ${chalk.cyan(config.ai.provider)}`);
            console.log(`  Current Model:    ${chalk.cyan(config.ai.model || 'default')}`);
            console.log(chalk.gray('─'.repeat(40)));

            const { action } = await inquirer.prompt([{
                type: 'list',
                name: 'action',
                message: 'What would you like to update?',
                choices: [
                    { name: 'Change AI Provider', value: 'provider' },
                    { name: 'Change AI Model', value: 'model' },
                    { name: 'Update API Key', value: 'key' },
                    { name: 'Exit', value: 'exit' }
                ]
            }]);

            if (action === 'exit') return;

            if (action === 'provider') {
                const { provider } = await inquirer.prompt([{
                    type: 'list',
                    name: 'provider',
                    message: 'Select new AI provider:',
                    choices: ['openai', 'anthropic', 'gemini', 'openrouter', 'ollama'],
                    default: config.ai.provider
                }]);

                config.ai.provider = provider as AIProviderKind;
                
                // Prompt for API key immediately if it's missing
                let canFetch = true;
                if (provider !== 'ollama') {
                    const envKey = `${provider.toUpperCase()}_API_KEY`;
                    if (!process.env[envKey]) {
                        console.log(chalk.yellow(`\nMissing API key for ${provider}.`));
                        const { key } = await inquirer.prompt([{
                            type: 'password',
                            name: 'key',
                            message: `Enter your ${provider.toUpperCase()} API Key:`,
                            mask: '*'
                        }]);
                        if (key.trim()) {
                            EnvEditor.update(rootDir, { [envKey]: key.trim() });
                            process.env[envKey] = key.trim(); // Update in-memory to fetch models right now
                        } else {
                            canFetch = false;
                        }
                    }
                }

                // Suggest changing model
                if (canFetch) {
                    try {
                        const providerInstance = AIProviderFactory.create(config);
                        if (providerInstance.listModels) {
                            const spinner = ora('Fetching available models...').start();
                            const models = await providerInstance.listModels();
                            spinner.stop();

                            if (models.length > 0) {
                                const { model } = await inquirer.prompt([{
                                    type: 'list',
                                    name: 'model',
                                    message: `Select model for ${provider}:`,
                                    choices: [
                                        ...models,
                                        { name: 'Custom model string...', value: 'custom' }
                                    ],
                                    default: models[0]
                                }]);

                                if (model === 'custom') {
                                    const { custom } = await inquirer.prompt([{
                                        type: 'input',
                                        name: 'custom',
                                        message: 'Enter custom model ID:'
                                    }]);
                                    config.ai.model = custom;
                                } else {
                                    config.ai.model = model;
                                }
                            }
                        }
                    } catch (err) {
                        console.log(chalk.yellow(`\nCould not fetch models automatically: ${err}`));
                    }
                }
            } else if (action === 'model') {
                let fetchedModels = false;
                try {
                    const providerInstance = AIProviderFactory.create(config);
                    if (providerInstance.listModels) {
                        const spinner = ora('Fetching available models...').start();
                        const models = await providerInstance.listModels();
                        spinner.stop();

                        if (models.length > 0) {
                            fetchedModels = true;
                            const { model } = await inquirer.prompt([{
                                type: 'list',
                                name: 'model',
                                message: `Select model for ${config.ai.provider}:`,
                                choices: [
                                    ...models,
                                    { name: 'Custom model string...', value: 'custom' }
                                ],
                                default: config.ai.model
                            }]);

                            if (model === 'custom') {
                                const { custom } = await inquirer.prompt([{
                                    type: 'input',
                                    name: 'custom',
                                    message: 'Enter custom model ID:'
                                }]);
                                config.ai.model = custom;
                            } else {
                                config.ai.model = model;
                            }
                        }
                    }
                } catch (err) {
                    console.log(chalk.yellow(`\nCould not fetch models automatically: ${String(err).split('\n')[0]}`));
                }

                if (!fetchedModels) {
                    const { custom } = await inquirer.prompt([{
                        type: 'input',
                        name: 'custom',
                        message: `Enter custom model ID for ${config.ai.provider}:`,
                        default: config.ai.model
                    }]);
                    config.ai.model = custom;
                }
            } else if (action === 'key') {
                const provider = config.ai.provider;
                if (provider === 'ollama') {
                    const { url } = await inquirer.prompt([{
                        type: 'input',
                        name: 'url',
                        message: 'Ollama Base URL:',
                        default: process.env['OLLAMA_BASE_URL'] ?? 'http://localhost:11434'
                    }]);
                    EnvEditor.update(rootDir, { 'OLLAMA_BASE_URL': url });
                } else {
                    const envKey = `${provider.toUpperCase()}_API_KEY`;
                    const { key } = await inquirer.prompt([{
                        type: 'password',
                        name: 'key',
                        message: `Enter new ${provider.toUpperCase()} API Key:`,
                        mask: '*'
                    }]);
                    EnvEditor.update(rootDir, { [envKey]: key });
                }
                console.log(chalk.green('\n✔ API key updated in .env'));
            }

            // Save updated config
            const spinner = ora('Saving configuration...').start();
            const configStore = ctx.configStore;
            configStore.save(config);
            configStore.saveToFile(config);
            spinner.succeed(chalk.green('Configuration updated successfully!'));
        });
}
