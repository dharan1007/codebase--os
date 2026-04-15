import type { ProjectConfig } from '../../types/index.js';

export type PresetName =
    | 'nextjs'
    | 'react'
    | 'react-native'
    | 'flutter'
    | 'android-kotlin'
    | 'ios-swift'
    | 'django'
    | 'fastapi'
    | 'express'
    | 'spring-boot'
    | 'laravel'
    | 'rails'
    | 'generic';

export interface ProjectPreset {
    name: PresetName;
    displayName: string;
    description: string;
    language: ProjectConfig['language'];
    layers: {
        database: string[];
        backend: string[];
        api: string[];
        frontend: string[];
    };
    exclude: string[];
    ai: {
        provider: ProjectConfig['ai']['provider'];
        model?: string;
    };
}

export const PROJECT_PRESETS: Record<PresetName, ProjectPreset> = {
    nextjs: {
        name: 'nextjs',
        displayName: 'Next.js (Full-Stack)',
        description: 'Next.js app with App Router or Pages Router',
        language: 'typescript',
        layers: {
            database: ['prisma', 'migrations', 'drizzle'],
            backend: ['lib', 'server', 'services', 'actions'],
            api: ['app/api', 'pages/api'],
            frontend: ['app', 'pages', 'components', 'hooks', 'contexts', 'layouts'],
        },
        exclude: ['node_modules', '.next', 'dist', '.git', '.cos', 'coverage'],
        ai: { provider: 'anthropic' },
    },
    react: {
        name: 'react',
        displayName: 'React (SPA)',
        description: 'Create React App or Vite React project',
        language: 'typescript',
        layers: {
            database: [],
            backend: ['src/services', 'src/api', 'src/store', 'src/redux'],
            api: ['src/api', 'src/graphql'],
            frontend: ['src/components', 'src/pages', 'src/views', 'src/hooks', 'src/layouts', 'src/screens'],
        },
        exclude: ['node_modules', 'build', 'dist', '.git', '.cos'],
        ai: { provider: 'anthropic' },
    },
    'react-native': {
        name: 'react-native',
        displayName: 'React Native',
        description: 'React Native mobile app',
        language: 'typescript',
        layers: {
            database: ['src/database', 'src/storage'],
            backend: ['src/services', 'src/store', 'src/redux', 'src/api'],
            api: ['src/api', 'src/graphql'],
            frontend: ['src/screens', 'src/components', 'src/navigation', 'src/hooks'],
        },
        exclude: ['node_modules', 'android', 'ios', '.git', '.cos'],
        ai: { provider: 'anthropic' },
    },
    flutter: {
        name: 'flutter',
        displayName: 'Flutter',
        description: 'Flutter cross-platform mobile/desktop app',
        language: 'dart',
        layers: {
            database: ['lib/data/datasources', 'lib/data/models'],
            backend: ['lib/data/repositories', 'lib/domain', 'lib/services', 'lib/blocs', 'lib/cubits'],
            api: ['lib/data/datasources/remote'],
            frontend: ['lib/presentation', 'lib/screens', 'lib/widgets', 'lib/pages', 'lib/views'],
        },
        exclude: ['.dart_tool', 'build', '.git', '.cos', '.flutter-plugins'],
        ai: { provider: 'anthropic' },
    },
    'android-kotlin': {
        name: 'android-kotlin',
        displayName: 'Android (Kotlin)',
        description: 'Native Android app with Kotlin',
        language: 'kotlin',
        layers: {
            database: ['app/src/main/java/database', 'app/src/main/java/dao'],
            backend: ['app/src/main/java/viewmodel', 'app/src/main/java/repository', 'app/src/main/java/service'],
            api: ['app/src/main/java/api', 'app/src/main/java/network'],
            frontend: ['app/src/main/java/ui', 'app/src/main/res'],
        },
        exclude: ['.gradle', 'build', '.git', '.cos'],
        ai: { provider: 'anthropic' },
    },
    'ios-swift': {
        name: 'ios-swift',
        displayName: 'iOS (Swift)',
        description: 'Native iOS app with Swift/SwiftUI',
        language: 'swift',
        layers: {
            database: ['CoreData', 'Models/Persistent'],
            backend: ['ViewModels', 'Services', 'Repositories'],
            api: ['Networking', 'API'],
            frontend: ['Views', 'Screens', 'Components'],
        },
        exclude: ['DerivedData', '.build', '.git', '.cos', 'Pods'],
        ai: { provider: 'anthropic' },
    },
    django: {
        name: 'django',
        displayName: 'Django (Python)',
        description: 'Django web framework project',
        language: 'python',
        layers: {
            database: ['migrations', 'models.py'],
            backend: ['views.py', 'services', 'admin.py', 'forms.py'],
            api: ['serializers.py', 'viewsets.py', 'urls.py'],
            frontend: ['templates', 'static'],
        },
        exclude: ['__pycache__', '.venv', 'venv', '.git', '.cos', '*.pyc'],
        ai: { provider: 'openai' },
    },
    fastapi: {
        name: 'fastapi',
        displayName: 'FastAPI (Python)',
        description: 'FastAPI REST API project',
        language: 'python',
        layers: {
            database: ['alembic', 'models', 'database.py'],
            backend: ['services', 'dependencies', 'core'],
            api: ['routers', 'schemas', 'api'],
            frontend: [],
        },
        exclude: ['__pycache__', '.venv', 'venv', '.git', '.cos'],
        ai: { provider: 'openai' },
    },
    express: {
        name: 'express',
        displayName: 'Express.js (Node)',
        description: 'Express.js REST API or full-stack app',
        language: 'javascript',
        layers: {
            database: ['models', 'migrations', 'sequelize', 'prisma'],
            backend: ['controllers', 'services', 'middleware', 'utils'],
            api: ['routes', 'api'],
            frontend: ['views', 'public', 'client'],
        },
        exclude: ['node_modules', 'dist', '.git', '.cos'],
        ai: { provider: 'anthropic' },
    },
    'spring-boot': {
        name: 'spring-boot',
        displayName: 'Spring Boot (Java)',
        description: 'Spring Boot Java backend service',
        language: 'java',
        layers: {
            database: ['src/main/java/entity', 'src/main/java/repository', 'src/main/resources'],
            backend: ['src/main/java/service', 'src/main/java/component'],
            api: ['src/main/java/controller', 'src/main/java/dto'],
            frontend: ['src/main/resources/static', 'src/main/resources/templates'],
        },
        exclude: ['target', '.gradle', 'build', '.git', '.cos'],
        ai: { provider: 'openai' },
    },
    laravel: {
        name: 'laravel',
        displayName: 'Laravel (PHP)',
        description: 'Laravel PHP web application',
        language: 'php',
        layers: {
            database: ['database/migrations', 'app/Models'],
            backend: ['app/Services', 'app/Repositories', 'app/Jobs', 'app/Console'],
            api: ['app/Http/Controllers', 'routes', 'app/Http/Resources'],
            frontend: ['resources/views', 'resources/js', 'resources/css'],
        },
        exclude: ['vendor', 'node_modules', '.git', '.cos', 'storage'],
        ai: { provider: 'openai' },
    },
    rails: {
        name: 'rails',
        displayName: 'Ruby on Rails',
        description: 'Ruby on Rails web application',
        language: 'ruby',
        layers: {
            database: ['db/migrate', 'app/models'],
            backend: ['app/services', 'app/jobs', 'app/mailers', 'app/helpers'],
            api: ['app/controllers', 'app/serializers', 'config/routes.rb'],
            frontend: ['app/views', 'app/assets', 'app/javascript'],
        },
        exclude: ['vendor', 'node_modules', '.git', '.cos', 'tmp', 'log'],
        ai: { provider: 'openai' },
    },
    generic: {
        name: 'generic',
        displayName: 'Generic Project',
        description: 'Any project — auto-detect layers',
        language: 'typescript',
        layers: {
            database: ['database', 'db', 'migrations', 'models'],
            backend: ['src', 'lib', 'server', 'backend', 'api'],
            api: ['api', 'routes', 'endpoints', 'graphql'],
            frontend: ['client', 'frontend', 'web', 'ui', 'views', 'components'],
        },
        exclude: ['node_modules', 'dist', 'build', '.git', '.cos', '__pycache__'],
        ai: { provider: 'anthropic' },
    },
};

export function getPreset(name: PresetName): ProjectPreset {
    return PROJECT_PRESETS[name];
}

export function listPresets(): ProjectPreset[] {
    return Object.values(PROJECT_PRESETS);
}
