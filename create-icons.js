const fs = require('fs');

// Create a minimal valid PNG file
// This is a 1x1 blue pixel PNG
const createMinimalPNG = (size) => {
  // PNG signature
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  
  // Create a simple blue square PNG
  // Using a minimal valid PNG structure
  const width = size;
  const height = size;
  
  // IHDR chunk
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8; // bit depth
  ihdrData[9] = 6; // color type (RGBA)
  ihdrData[10] = 0; // compression
  ihdrData[11] = 0; // filter
  ihdrData[12] = 0; // interlace
  
  const ihdrChunk = createChunk('IHDR', ihdrData);
  
  // Create image data (blue square)
  const pixelData = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const offset = i * 4;
    pixelData[offset] = 100;     // R
    pixelData[offset + 1] = 150;  // G
    pixelData[offset + 2] = 255;  // B
    pixelData[offset + 3] = 255; // A
  }
  
  // Compress the data (simple deflate - using zlib)
  const zlib = require('zlib');
  const compressed = zlib.deflateSync(pixelData);
  const idatChunk = createChunk('IDAT', compressed);
  
  // IEND chunk
  const iendChunk = createChunk('IEND', Buffer.alloc(0));
  
  return Buffer.concat([signature, ihdrChunk, idatChunk, iendChunk]);
};

function createChunk(type, data) {
  const typeBuffer = Buffer.from(type);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  
  const chunk = Buffer.concat([length, typeBuffer, data]);
  
  // Calculate CRC32
  const crc = require('crypto').createHash('sha256').update(chunk.slice(4)).digest();
  const crcBuffer = Buffer.alloc(4);
  crcBuffer.writeUInt32BE(crc.readUInt32BE(0) & 0xFFFFFFFF, 0);
  
  return Buffer.concat([chunk, crcBuffer]);
}

// Create icons
const sizes = [16, 48, 128];
sizes.forEach(size => {
  const png = createMinimalPNG(size);
  fs.writeFileSync(`public/icon${size}.png`, png);
  console.log(`Created icon${size}.png`);
});

