import sharp from 'sharp';

// 1024x1024の青い画像を生成
await sharp({
  create: {
    width: 1024,
    height: 1024,
    channels: 4,
    background: { r: 0, g: 100, b: 200, alpha: 1 }
  }
})
.png()
.toFile('app-icon.png');

console.log('app-icon.png generated successfully');
