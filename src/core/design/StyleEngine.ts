export interface DesignTokens {
    colors: {
        primary: string;
        secondary: string;
        accent: string;
        background: string;
        surface: string;
        text: string;
        textMuted: string;
        error: string;
        success: string;
    };
    spacing: {
        xs: number;
        sm: number;
        md: number;
        lg: number;
        xl: number;
    };
    radius: {
        soft: string;
        sharp: string;
        round: string;
    };
    fonts: {
        display: string;
        body: string;
        mono: string;
    };
    shadows: {
        soft: string;
        high: string;
        glow: string;
    };
}

export class StyleEngine {
    private tokens: DesignTokens;

    constructor() {
        // Initializing with the requested 'vibrant/premium' default palette
        this.tokens = {
            colors: {
                primary: '#6366f1', // Indigo
                secondary: '#ec4899', // Pink
                accent: '#8b5cf6', // Violet
                background: '#0f172a', // Slate 900
                surface: '#1e293b', // Slate 800
                text: '#f8fafc', // Slate 50
                textMuted: '#94a3b8', // Slate 400
                error: '#ef4444',
                success: '#22c55e'
            },
            spacing: { xs: 4, sm: 8, md: 16, lg: 32, xl: 64 },
            radius: { soft: '12px', sharp: '4px', round: '50%' },
            fonts: {
                display: "'Outfit', sans-serif",
                body: "'Inter', sans-serif",
                mono: "'Fira Code', monospace"
            },
            shadows: {
                soft: '0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)',
                high: '0 20px 25px -5px rgb(0 0 0 / 0.1), 0 8px 10px -6px rgb(0 0 0 / 0.1)',
                glow: '0 0 20px rgba(99, 102, 241, 0.4)'
            }
        };
    }

    getTokens(): DesignTokens {
        return this.tokens;
    }

    updateTokens(newTokens: Partial<DesignTokens>): void {
        this.tokens = { ...this.tokens, ...newTokens };
    }

    generateCSSVariables(): string {
        const { colors, spacing, radius, fonts, shadows } = this.tokens;
        return `
:root {
  --color-primary: ${colors.primary};
  --color-secondary: ${colors.secondary};
  --color-accent: ${colors.accent};
  --color-bg: ${colors.background};
  --color-surface: ${colors.surface};
  --color-text: ${colors.text};
  --color-text-muted: ${colors.textMuted};
  --color-error: ${colors.error};
  --color-success: ${colors.success};
  
  --space-xs: ${spacing.xs}px;
  --space-sm: ${spacing.sm}px;
  --space-md: ${spacing.md}px;
  --space-lg: ${spacing.lg}px;
  --space-xl: ${spacing.xl}px;
  
  --radius-soft: ${radius.soft};
  --radius-sharp: ${radius.sharp};
  --radius-round: ${radius.round};
  
  --font-display: ${fonts.display};
  --font-body: ${fonts.body};
  --font-mono: ${fonts.mono};
  
  --shadow-soft: ${shadows.soft};
  --shadow-high: ${shadows.high};
  --shadow-glow: ${shadows.glow};
}
        `.trim();
    }
}
