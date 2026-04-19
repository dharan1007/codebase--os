import { DesignTokens } from './StyleEngine.js';

export class MotionEngine {
    constructor(private tokens: DesignTokens) {}

    generateInteractionScripts(): string {
        return `
import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';

gsap.registerPlugin(ScrollTrigger);

export const initMotion = () => {
    // Staggered list animations
    gsap.from('.stagger-item', {
        duration: 0.8,
        opacity: 0,
        y: 20,
        stagger: 0.1,
        ease: 'power3.out'
    });

    // Parallax scroll for hero
    gsap.to('.hero-3d', {
        scrollTrigger: {
            trigger: '.hero-3d',
            start: 'top top',
            end: 'bottom top',
            scrub: true
        },
        y: 100,
        rotateX: 10,
        ease: 'none'
    });
    
    // Smooth reveal for glass surfaces
    gsap.from('.surface-glass', {
        duration: 1.2,
        opacity: 0,
        scale: 0.95,
        filter: 'blur(10px)',
        ease: 'elastic.out(1, 0.75)'
    });
};
        `.trim();
    }
}
