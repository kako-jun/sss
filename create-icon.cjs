const fs = require('fs');

// 最小限の1024x1024 PNG画像（透明）のBase64データ
const base64Data = 'iVBORw0KGgoAAAANSUhEUgAABAAAAAQACAIAAADwf7zUAAAACXBIWXMAAC4jAAAuIwF4pT92AAADTUlEQVR4nO3BMQEAAADCoPVPbQhfoAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAOBuoxEAAWzxcLYAAAAASUVORK5CYII=';

const buffer = Buffer.from(base64Data, 'base64');
fs.writeFileSync('app-icon.png', buffer);

console.log('app-icon.png created successfully');
