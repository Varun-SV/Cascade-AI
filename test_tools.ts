import { PDFCreateTool } from './src/tools/pdf.js';
import { CodeInterpreterTool } from './src/tools/interpreter.js';
import fs from 'node:fs';
import path from 'node:path';

async function testTools() {
  const pdfTool = new PDFCreateTool();
  const interpreterTool = new CodeInterpreterTool();
  
  const options = {
    tierId: 'test',
    sessionId: 'test-session',
    requireApproval: false
  };

  console.log('--- Testing PDFCreateTool ---');
  const pdfPath = path.join(process.cwd(), 'test_output.pdf');
  try {
    const pdfResult = await pdfTool.execute({
      path: pdfPath,
      content: 'This is a test story about a robot who learned to write PDFs.',
      title: 'Test Robot Story'
    }, options as any);
    console.log(pdfResult);
    if (fs.existsSync(pdfPath)) {
      console.log('PDF file exists.');
      // Simple check for PDF header
      const buffer = fs.readFileSync(pdfPath);
      if (buffer.toString('utf8', 0, 5) === '%PDF-') {
        console.log('PDF header verified.');
      } else {
        console.log('ERROR: Invalid PDF header.');
      }
    }
  } catch (err) {
    console.error('PDF Tool Failed:', err);
  }

  console.log('\n--- Testing CodeInterpreterTool (Python) ---');
  try {
    const pyResult = await interpreterTool.execute({
      language: 'python',
      code: 'import sys; print("Hello from Python " + sys.version)'
    }, options as any);
    console.log(pyResult);
    if (pyResult.includes('Hello from Python')) {
      console.log('Python execution verified.');
    }
  } catch (err) {
    console.error('Python Interpreter Failed:', err);
  }

  console.log('\n--- Testing CodeInterpreterTool (Node.js) ---');
  try {
    const jsResult = await interpreterTool.execute({
      language: 'nodejs',
      code: 'console.log("Hello from Node " + process.version)'
    }, options as any);
    console.log(jsResult);
    if (jsResult.includes('Hello from Node')) {
      console.log('Node.js execution verified.');
    }
  } catch (err) {
    console.error('Node.js Interpreter Failed:', err);
  }
}

testTools();
