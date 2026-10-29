const fs = require('node:fs');

fs.mkdirSync('public', { recursive: true });
fs.copyFileSync('front/index.html', 'public/index.html');
console.log('Copied the frontend into public/.');
