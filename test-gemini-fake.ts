import { GoogleGenerativeAI } from '@google/generative-ai';

async function test() {
    const key = 'AIzaSy' + 'A'.repeat(33); // Fake 39-char key
    const genAI = new GoogleGenerativeAI(key);

    console.log('Testing gemini-1.5-flash with fake key...');
    try {
        const m2 = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
        await m2.generateContent('hi');
        console.log('SUCCESS');
    } catch (e: any) { console.log('FAIL:', e.message); }
}

test();
