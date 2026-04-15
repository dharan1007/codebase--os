import { GoogleGenerativeAI } from '@google/generative-ai';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.join('..', '.env') });

async function test() {
    const key = process.env.GEMINI_API_KEY;
    if (!key) return;

    const genAI = new GoogleGenerativeAI(key);
    console.log('Testing gemini-2.5-flash with HUGE payload...');
    
    // Generate a 400KB string
    const hugePayload = 'hi '.repeat(100000);
    
    try {
        const m1 = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
        const res = await m1.generateContent(hugePayload);
        console.log('SUCCESS:', res.response.text().substring(0, 50));
    } catch (e: any) { 
        console.log('FAIL:', String(e)); 
    }
}

test();
