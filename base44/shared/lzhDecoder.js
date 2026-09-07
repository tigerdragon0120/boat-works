// 純JavaScript LZH (LH5) デコーダー
// LHA/LHarc形式のLZHファイルをデコードする
// Denoバックエンド関数環境用(Deno.Command不可・WebAssembly不可)
// 
// LH5方式の仕様に基づく実装(LHA Level 1/2ヘッダー対応):
// - LZSS + 動的Huffman符号化
// - スライディングウィンドウ: 8192 bytes (LH5)
// - 最小マッチ長: 3 bytes
// - ブロック単位でHuffmanテーブルを更新

export function decodeLzh(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  let pos = 0;

  // === LZHアーカイブヘッダー解析 ===
  // ヘッダーサイズ (1 byte) - このバイト自体を含まないサイズ
  const headerSize = bytes[pos++];

  // Level判定 (byte 20にlevelが格納されている)
  // Level 0: header_size + 1 byte = total header
  // Level 1/2: header_size + 1 byte = total header (CRC含む)
  const level = bytes[20];

  // 圧縮方式 (5 bytes, bytes 2-6)
  const method = String.fromCharCode(bytes[2], bytes[3], bytes[4], bytes[5], bytes[6]);

  if (!method.includes('lh5') && !method.includes('lh4') && !method.includes('lh6') && !method.includes('lh7') && !method.includes('lzs')) {
    throw new Error(`Unsupported compression method: ${method}`);
  }

  // 圧縮サイズ (bytes 7-10, little-endian)
  const compressedSize = bytes[7] | (bytes[8] << 8) | (bytes[9] << 16) | (bytes[10] << 24);

  // 非圧縮サイズ (bytes 11-14, little-endian)
  const uncompressedSize = bytes[11] | (bytes[12] << 8) | (bytes[13] << 16) | (bytes[14] << 24);

  // 圧縮データの開始位置 = headerSize + 1 (headerSize byte自体)
  const dataStart = headerSize + 1;

  // === LZSS + Huffman デコード ===
  const compressedData = bytes.slice(dataStart, dataStart + compressedSize);
  const output = decodeLh5(compressedData, uncompressedSize);
  return output;
}

// LH5デコード(LZSS + 動的Huffman)
function decodeLh5(compressed, expectedSize) {
  const windowSize = 8192; // LH5
  const window = new Uint8Array(windowSize);
  let windowPos = 0;

  const output = new Uint8Array(expectedSize);
  let outputPos = 0;

  const bitReader = new BitReader(compressed);

  while (outputPos < expectedSize) {
    // ブロックサイズ取得 (16 bits, little-endian byte order)
    const blockSize = bitReader.readBits(16);
    if (blockSize === 0) break;

    // ブロックの終了位置を設定 (blockSizeはバイト数)
    const blockEndBitPos = bitReader.bitPos + blockSize * 8;

    // Huffmanテーブル構築
    const literalTree = buildHuffmanTree(bitReader);
    const offsetTree = buildHuffmanTree(bitReader);

    // ブロックデータのデコード
    while (bitReader.bitPos < blockEndBitPos && outputPos < expectedSize) {
      const symbol = decodeSymbol(bitReader, literalTree);

      if (symbol < 0) break;

      if (symbol < 256) {
        // リテラル
        output[outputPos++] = symbol;
        window[windowPos] = symbol;
        windowPos = (windowPos + 1) % windowSize;
      } else {
        // マッチ
        const length = symbol - 256 + 3; // 最小マッチ長3

        // オフセットをデコード
        const offsetSymbol = decodeSymbol(bitReader, offsetTree);
        if (offsetSymbol < 0) break;

        let offset;
        if (offsetSymbol === 0) {
          offset = 1;
        } else {
          // offsetSymbol番目のビットを読む
          const extraBits = offsetSymbol;
          const extraValue = bitReader.readBits(extraBits);
          offset = (1 << extraBits) + extraValue + 1;
        }

        // マッチコピー
        const copyPos = (windowPos - offset + windowSize) % windowSize;
        for (let i = 0; i < length; i++) {
          const b = window[(copyPos + i) % windowSize];
          if (outputPos < expectedSize) {
            output[outputPos++] = b;
          }
          window[windowPos] = b;
          windowPos = (windowPos + 1) % windowSize;
        }
      }
    }
  }

  return output;
}

// ビットリーダー
class BitReader {
  constructor(data) {
    this.data = data;
    this.bytePos = 0;
    this.bitPos = 0; // 全体のビット位置
    this.currentByte = 0;
    this.bitsLeft = 0;
  }

  readBit() {
    if (this.bitsLeft === 0) {
      this.currentByte = this.data[this.bytePos++];
      this.bitsLeft = 8;
    }
    this.bitsLeft--;
    this.bitPos++;
    return (this.currentByte >> this.bitsLeft) & 1;
  }

  readBits(n) {
    let value = 0;
    for (let i = 0; i < n; i++) {
      value = (value << 1) | this.readBit();
    }
    return value;
  }
}

// Huffmanテーブル構築
function buildHuffmanTree(bitReader) {
  // 符号数を取得 (9 bits)
  const numSymbols = bitReader.readBits(9);
  if (numSymbols === 0) return null;

  const codeLengths = new Array(numSymbols);

  // 符号長のHuffmanテーブルを構築
  const lengthCodeLengths = new Array(20).fill(0);
  const numLengthCodes = bitReader.readBits(5);
  for (let i = 0; i < numLengthCodes; i++) {
    lengthCodeLengths[i] = bitReader.readBits(3);
  }

  // 符号長のHuffmanテーブルを構築
  const lengthTree = buildCanonicalHuffman(lengthCodeLengths);

  // 符号長を読む
  let i = 0;
  while (i < numSymbols) {
    const symbol = decodeSymbol(bitReader, lengthTree);
    if (symbol < 0) break;

    if (symbol < 19) {
      codeLengths[i++] = symbol;
    } else if (symbol === 19) {
      // 繰り返し(3-6回, 前の値)
      const count = bitReader.readBits(2) + 3;
      const val = i > 0 ? codeLengths[i - 1] : 0;
      for (let j = 0; j < count && i < numSymbols; j++) {
        codeLengths[i++] = val;
      }
    } else if (symbol === 20) {
      // ゼロ繰り返し(3-10回)
      const count = bitReader.readBits(3) + 3;
      for (let j = 0; j < count && i < numSymbols; j++) {
        codeLengths[i++] = 0;
      }
    } else if (symbol === 21) {
      // ゼロ繰り返し(11-138回)
      const count = bitReader.readBits(7) + 11;
      for (let j = 0; j < count && i < numSymbols; j++) {
        codeLengths[i++] = 0;
      }
    }
  }

  // 最終的なHuffmanテーブルを構築
  return buildCanonicalHuffman(codeLengths);
}

// 正準Huffmanテーブル構築
function buildCanonicalHuffman(codeLengths) {
  const maxLen = Math.max(...codeLengths);
  if (maxLen === 0) return null;

  // 各符号長の数を数える
  const blCount = new Array(maxLen + 1).fill(0);
  for (const len of codeLengths) {
    if (len > 0) blCount[len]++;
  }

  // 各符号長の最小コードを計算
  const nextCode = new Array(maxLen + 1).fill(0);
  let code = 0;
  for (let bits = 1; bits <= maxLen; bits++) {
    code = (code + blCount[bits - 1]) << 1;
    nextCode[bits] = code;
  }

  // 各シンボルにコードを割り当て
  const codes = [];
  for (let i = 0; i < codeLengths.length; i++) {
    if (codeLengths[i] > 0) {
      codes.push({ symbol: i, code: nextCode[codeLengths[i]], len: codeLengths[i] });
      nextCode[codeLengths[i]]++;
    }
  }

  // デコード用ツリーを構築
  return new HuffmanDecoder(codes);
}

// Huffman デコーダー
class HuffmanDecoder {
  constructor(codes) {
    this.root = {};
    for (const { symbol, code, len } of codes) {
      let node = this.root;
      for (let i = len - 1; i >= 0; i--) {
        const bit = (code >> i) & 1;
        const key = bit.toString();
        if (i === 0) {
          node[key] = { symbol, isLeaf: true };
        } else {
          if (!node[key]) node[key] = {};
          node = node[key];
        }
      }
    }
  }

  decode(bitReader) {
    let node = this.root;
    while (node && !node.isLeaf) {
      const bit = bitReader.readBit();
      node = node[bit.toString()];
    }
    return node ? node.symbol : -1;
  }
}

function decodeSymbol(bitReader, tree) {
  if (!tree) return -1;
  return tree.decode(bitReader);
}

// Shift-JIS デコード
export function decodeShiftJIS(uint8Array) {
  const decoder = new TextDecoder('shift_jis');
  return decoder.decode(uint8Array);
}