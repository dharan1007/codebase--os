import { GoogleGenerativeAI } from '@google/generative-ai';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.join('..', '.env') });

async function test() {
    const key = process.env.GEMINI_API_KEY;
    if (!key) return;

    // Direct HTTP fetch to list models
    try {
        const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${key}`);
        const data = await resp.json();
        console.log('Available models:', JSON.stringify(data, null, 2));
    } catch (err: any) {
        console.log('List models failed:', err.message);
    }
}

test();
