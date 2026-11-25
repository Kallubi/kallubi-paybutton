/*! Kallubi Pay Button v1.2.0 | Apache-2.0 | https://kallubi-bsv-explorer.de
 *  Non-custodial BSV pay button: the buyer pays straight to the merchant's own address.
 *  No keys, no seeds, no custody, no cookies, no tracking. Optional shipping address (data-shipping) goes only to the merchant.
 *  v1.2.0: optional EUR/USD pricing (data-amount-fiat), order reference (data-order-id), data-expires-min, late-payment flag.
 *  The kallubi:paid event is a UX signal only. A shop must verify every payment on its own server (see verify/).
 *  Bundles qrcode-generator 1.4.4 (MIT, (c) 2009 Kazuhiko Arase). */
(function () {
  'use strict';
  if (typeof window === 'undefined' || (window.KallubiPay && window.KallubiPay.version)) return;

  var VERSION = '1.2.0';
  // Payment detection: Kallubi's own BSV node first. The public fallback is only used where the own node cannot answer
  // (no address index yet, node unreachable, tx not known yet). Amounts are never taken from JSON: every candidate tx is
  // fetched as raw hex, hashed (must equal the txid) and parsed here, so neither source can fake an amount.
  var NODE_API = 'https://node.kallubi-bsv-explorer.de/v1/bsv/main';
  var FALLBACK_API = 'https://api.whatsonchain.com/v1/bsv/main';
  var MAX_TX_HEX = 32 * 1024 * 1024;   // raw tx up to 16 MB is verified in the browser; bigger payment txs are not plausible
  var DROP_CHECKS = 4;                 // a seen tx that no source knows any more for 4 checks in a row ...
  var DROP_MIN_MS = 120000;            // ... and at least 2 min after it was seen counts as dropped (double spend / evicted)
  var EXPLORER_TX = 'https://kallubi-bsv-explorer.de/?tx=';
  var KALLUBI_URL = 'https://kallubi-bsv-explorer.de/';
  var POLL_MS = 5000;          // normal poll interval
  var POLL_MAX_MS = 30000;     // max backoff after errors / HTTP 429
  var DEFAULT_TTL_S = 900;     // 15 min payment window
  var TEST_DELAY_MS = 8000;    // test mode: simulated payment after ~8 s
  var DEFAULT_CONFIRM_ABOVE = 1000000;   // 0.01 BSV: invoices >= this wait for 1 block confirmation
  var CONF_POLL_MS = 15000;    // while waiting for the confirmation
  var CONF_MAX_MS = 6 * 3600 * 1000;     // give up polling for the confirmation after 6 h (page stays on 'seen')
  var MAX_SATS = 2100000000000000;
  var SVGNS = 'http://www.w3.org/2000/svg';
  /* v1.2.0 fiat pricing. Same price rule as the Kallubi wallets: CoinGecko (EUR + USD) first, WhatsOnChain (USD only) as fallback. */
  var RATE_CG = 'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin-cash-sv&vs_currencies=eur,usd&include_last_updated_at=true';
  var RATE_WOC = FALLBACK_API + '/exchangerate';
  var RATE_MAX_AGE_S = 600;    // a rate older than 10 min is refused (no stale quote)
  var RATE_FUTURE_S = 300;     // a rate time more than 5 min in the future is refused (bad clock / bad data)
  var RATE_MAX = 10000000;     // 1 BSV > 10,000,000 EUR/USD is treated as bad data
  // EUR backup when CoinGecko fails: WhatsOnChain USD rate / official ECB EUR/USD reference rate. The ECB daily XML cannot be
  // read by a browser (no CORS header); the ECB Data Portal publishes the same reference rate with CORS, so the button uses that.
  var RATE_ECB = 'https://data-api.ecb.europa.eu/service/data/EXR/D.USD.EUR.SP00.A?lastNObservations=1&format=csvdata';
  var ECB_MAX_AGE_D = 5;       // published on ECB working days only: up to 5 calendar days covers weekends + Easter/Christmas
  var ECB_CACHE_MS = 3600000;  // a good ECB answer is reused for 1 hour (it changes once a day)
  var ECB_MIN = 0.5, ECB_MAX = 2;   // USD per EUR outside this range = bad data
  var DEFAULT_CONFIRM_ABOVE_FIAT = 20000;  // 200.00 EUR: with a passed quick check, paid at 0-conf; above wait for 1 block
  var FALLBACK_ZERO_CONF_CENTS = 2000;     // 20.00 EUR: 0-conf still allowed when the quick check is unavailable (no node / no Broadcaster)
  var QUICK_WATCH_MS = 5000;               // 3-5 s observation window for a competing double-spend
  var QUICK_POLL_MS = 1000;
  var FEE_SAT_PER_KB = 100;                // used if GET /policy is unavailable; official mainnet policy is 100 sat/kB
  var FINAL_SEQUENCE = 4294967295;         // 0xffffffff: input is final
  var QUICK_MIN_MS = 3000;                 // data-quick-ms cannot shorten the double-spend window below 3 s
  var QUICK_MAX_INPUTS = 20;               // more inputs: fee check skipped (too many parent lookups) -> check unavailable
  var QUICK_PREV_BUDGET_MS = 20000;        // loading the parent txs for the fee check may take at most 20 s
  var BROADCASTERS = [
    'https://arcade-eu-1.bsvblockchain.tech',
    'https://arcade-us-1.bsvblockchain.tech',
    'https://arcade.gorillapool.io'
  ];
  var FIATS = { EUR: 1, USD: 1 };
  var MAX_FIAT_CENTS = 100000000;        // 1,000,000.00
  var LATE_WATCH_MS = 30 * 60 * 1000;    // after expiry keep looking for a (late) payment for 30 min, then stop
  var LATE_POLL_MS = 15000;
  var ORDER_RE = /^[A-Za-z0-9][A-Za-z0-9._:\/#-]{0,63}$/;
  var USED_TX = {};

  /* ------------------------------------------------------------------ vendored QR lib */
  var qrcode = (function () {
//---------------------------------------------------------------------
//
// QR Code Generator for JavaScript
//
// Copyright (c) 2009 Kazuhiko Arase
//
// URL: http://www.d-project.com/
//
// Licensed under the MIT license:
//  http://www.opensource.org/licenses/mit-license.php
//
// The word 'QR Code' is registered trademark of
// DENSO WAVE INCORPORATED
//  http://www.denso-wave.com/qrcode/faqpatent-e.html
//
//---------------------------------------------------------------------

var qrcode = function() {

  //---------------------------------------------------------------------
  // qrcode
  //---------------------------------------------------------------------

  /**
   * qrcode
   * @param typeNumber 1 to 40
   * @param errorCorrectionLevel 'L','M','Q','H'
   */
  var qrcode = function(typeNumber, errorCorrectionLevel) {

    var PAD0 = 0xEC;
    var PAD1 = 0x11;

    var _typeNumber = typeNumber;
    var _errorCorrectionLevel = QRErrorCorrectionLevel[errorCorrectionLevel];
    var _modules = null;
    var _moduleCount = 0;
    var _dataCache = null;
    var _dataList = [];

    var _this = {};

    var makeImpl = function(test, maskPattern) {

      _moduleCount = _typeNumber * 4 + 17;
      _modules = function(moduleCount) {
        var modules = new Array(moduleCount);
        for (var row = 0; row < moduleCount; row += 1) {
          modules[row] = new Array(moduleCount);
          for (var col = 0; col < moduleCount; col += 1) {
            modules[row][col] = null;
          }
        }
        return modules;
      }(_moduleCount);

      setupPositionProbePattern(0, 0);
      setupPositionProbePattern(_moduleCount - 7, 0);
      setupPositionProbePattern(0, _moduleCount - 7);
      setupPositionAdjustPattern();
      setupTimingPattern();
      setupTypeInfo(test, maskPattern);

      if (_typeNumber >= 7) {
        setupTypeNumber(test);
      }

      if (_dataCache == null) {
        _dataCache = createData(_typeNumber, _errorCorrectionLevel, _dataList);
      }

      mapData(_dataCache, maskPattern);
    };

    var setupPositionProbePattern = function(row, col) {

      for (var r = -1; r <= 7; r += 1) {

        if (row + r <= -1 || _moduleCount <= row + r) continue;

        for (var c = -1; c <= 7; c += 1) {

          if (col + c <= -1 || _moduleCount <= col + c) continue;

          if ( (0 <= r && r <= 6 && (c == 0 || c == 6) )
              || (0 <= c && c <= 6 && (r == 0 || r == 6) )
              || (2 <= r && r <= 4 && 2 <= c && c <= 4) ) {
            _modules[row + r][col + c] = true;
          } else {
            _modules[row + r][col + c] = false;
          }
        }
      }
    };

    var getBestMaskPattern = function() {

      var minLostPoint = 0;
      var pattern = 0;

      for (var i = 0; i < 8; i += 1) {

        makeImpl(true, i);

        var lostPoint = QRUtil.getLostPoint(_this);

        if (i == 0 || minLostPoint > lostPoint) {
          minLostPoint = lostPoint;
          pattern = i;
        }
      }

      return pattern;
    };

    var setupTimingPattern = function() {

      for (var r = 8; r < _moduleCount - 8; r += 1) {
        if (_modules[r][6] != null) {
          continue;
        }
        _modules[r][6] = (r % 2 == 0);
      }

      for (var c = 8; c < _moduleCount - 8; c += 1) {
        if (_modules[6][c] != null) {
          continue;
        }
        _modules[6][c] = (c % 2 == 0);
      }
    };

    var setupPositionAdjustPattern = function() {

      var pos = QRUtil.getPatternPosition(_typeNumber);

      for (var i = 0; i < pos.length; i += 1) {

        for (var j = 0; j < pos.length; j += 1) {

          var row = pos[i];
          var col = pos[j];

          if (_modules[row][col] != null) {
            continue;
          }

          for (var r = -2; r <= 2; r += 1) {

            for (var c = -2; c <= 2; c += 1) {

              if (r == -2 || r == 2 || c == -2 || c == 2
                  || (r == 0 && c == 0) ) {
                _modules[row + r][col + c] = true;
              } else {
                _modules[row + r][col + c] = false;
              }
            }
          }
        }
      }
    };

    var setupTypeNumber = function(test) {

      var bits = QRUtil.getBCHTypeNumber(_typeNumber);

      for (var i = 0; i < 18; i += 1) {
        var mod = (!test && ( (bits >> i) & 1) == 1);
        _modules[Math.floor(i / 3)][i % 3 + _moduleCount - 8 - 3] = mod;
      }

      for (var i = 0; i < 18; i += 1) {
        var mod = (!test && ( (bits >> i) & 1) == 1);
        _modules[i % 3 + _moduleCount - 8 - 3][Math.floor(i / 3)] = mod;
      }
    };

    var setupTypeInfo = function(test, maskPattern) {

      var data = (_errorCorrectionLevel << 3) | maskPattern;
      var bits = QRUtil.getBCHTypeInfo(data);

      // vertical
      for (var i = 0; i < 15; i += 1) {

        var mod = (!test && ( (bits >> i) & 1) == 1);

        if (i < 6) {
          _modules[i][8] = mod;
        } else if (i < 8) {
          _modules[i + 1][8] = mod;
        } else {
          _modules[_moduleCount - 15 + i][8] = mod;
        }
      }

      // horizontal
      for (var i = 0; i < 15; i += 1) {

        var mod = (!test && ( (bits >> i) & 1) == 1);

        if (i < 8) {
          _modules[8][_moduleCount - i - 1] = mod;
        } else if (i < 9) {
          _modules[8][15 - i - 1 + 1] = mod;
        } else {
          _modules[8][15 - i - 1] = mod;
        }
      }

      // fixed module
      _modules[_moduleCount - 8][8] = (!test);
    };

    var mapData = function(data, maskPattern) {

      var inc = -1;
      var row = _moduleCount - 1;
      var bitIndex = 7;
      var byteIndex = 0;
      var maskFunc = QRUtil.getMaskFunction(maskPattern);

      for (var col = _moduleCount - 1; col > 0; col -= 2) {

        if (col == 6) col -= 1;

        while (true) {

          for (var c = 0; c < 2; c += 1) {

            if (_modules[row][col - c] == null) {

              var dark = false;

              if (byteIndex < data.length) {
                dark = ( ( (data[byteIndex] >>> bitIndex) & 1) == 1);
              }

              var mask = maskFunc(row, col - c);

              if (mask) {
                dark = !dark;
              }

              _modules[row][col - c] = dark;
              bitIndex -= 1;

              if (bitIndex == -1) {
                byteIndex += 1;
                bitIndex = 7;
              }
            }
          }

          row += inc;

          if (row < 0 || _moduleCount <= row) {
            row -= inc;
            inc = -inc;
            break;
          }
        }
      }
    };

    var createBytes = function(buffer, rsBlocks) {

      var offset = 0;

      var maxDcCount = 0;
      var maxEcCount = 0;

      var dcdata = new Array(rsBlocks.length);
      var ecdata = new Array(rsBlocks.length);

      for (var r = 0; r < rsBlocks.length; r += 1) {

        var dcCount = rsBlocks[r].dataCount;
        var ecCount = rsBlocks[r].totalCount - dcCount;

        maxDcCount = Math.max(maxDcCount, dcCount);
        maxEcCount = Math.max(maxEcCount, ecCount);

        dcdata[r] = new Array(dcCount);

        for (var i = 0; i < dcdata[r].length; i += 1) {
          dcdata[r][i] = 0xff & buffer.getBuffer()[i + offset];
        }
        offset += dcCount;

        var rsPoly = QRUtil.getErrorCorrectPolynomial(ecCount);
        var rawPoly = qrPolynomial(dcdata[r], rsPoly.getLength() - 1);

        var modPoly = rawPoly.mod(rsPoly);
        ecdata[r] = new Array(rsPoly.getLength() - 1);
        for (var i = 0; i < ecdata[r].length; i += 1) {
          var modIndex = i + modPoly.getLength() - ecdata[r].length;
          ecdata[r][i] = (modIndex >= 0)? modPoly.getAt(modIndex) : 0;
        }
      }

      var totalCodeCount = 0;
      for (var i = 0; i < rsBlocks.length; i += 1) {
        totalCodeCount += rsBlocks[i].totalCount;
      }

      var data = new Array(totalCodeCount);
      var index = 0;

      for (var i = 0; i < maxDcCount; i += 1) {
        for (var r = 0; r < rsBlocks.length; r += 1) {
          if (i < dcdata[r].length) {
            data[index] = dcdata[r][i];
            index += 1;
          }
        }
      }

      for (var i = 0; i < maxEcCount; i += 1) {
        for (var r = 0; r < rsBlocks.length; r += 1) {
          if (i < ecdata[r].length) {
            data[index] = ecdata[r][i];
            index += 1;
          }
        }
      }

      return data;
    };

    var createData = function(typeNumber, errorCorrectionLevel, dataList) {

      var rsBlocks = QRRSBlock.getRSBlocks(typeNumber, errorCorrectionLevel);

      var buffer = qrBitBuffer();

      for (var i = 0; i < dataList.length; i += 1) {
        var data = dataList[i];
        buffer.put(data.getMode(), 4);
        buffer.put(data.getLength(), QRUtil.getLengthInBits(data.getMode(), typeNumber) );
        data.write(buffer);
      }

      // calc num max data.
      var totalDataCount = 0;
      for (var i = 0; i < rsBlocks.length; i += 1) {
        totalDataCount += rsBlocks[i].dataCount;
      }

      if (buffer.getLengthInBits() > totalDataCount * 8) {
        throw 'code length overflow. ('
          + buffer.getLengthInBits()
          + '>'
          + totalDataCount * 8
          + ')';
      }

      // end code
      if (buffer.getLengthInBits() + 4 <= totalDataCount * 8) {
        buffer.put(0, 4);
      }

      // padding
      while (buffer.getLengthInBits() % 8 != 0) {
        buffer.putBit(false);
      }

      // padding
      while (true) {

        if (buffer.getLengthInBits() >= totalDataCount * 8) {
          break;
        }
        buffer.put(PAD0, 8);

        if (buffer.getLengthInBits() >= totalDataCount * 8) {
          break;
        }
        buffer.put(PAD1, 8);
      }

      return createBytes(buffer, rsBlocks);
    };

    _this.addData = function(data, mode) {

      mode = mode || 'Byte';

      var newData = null;

      switch(mode) {
      case 'Numeric' :
        newData = qrNumber(data);
        break;
      case 'Alphanumeric' :
        newData = qrAlphaNum(data);
        break;
      case 'Byte' :
        newData = qr8BitByte(data);
        break;
      case 'Kanji' :
        newData = qrKanji(data);
        break;
      default :
        throw 'mode:' + mode;
      }

      _dataList.push(newData);
      _dataCache = null;
    };

    _this.isDark = function(row, col) {
      if (row < 0 || _moduleCount <= row || col < 0 || _moduleCount <= col) {
        throw row + ',' + col;
      }
      return _modules[row][col];
    };

    _this.getModuleCount = function() {
      return _moduleCount;
    };

    _this.make = function() {
      if (_typeNumber < 1) {
        var typeNumber = 1;

        for (; typeNumber < 40; typeNumber++) {
          var rsBlocks = QRRSBlock.getRSBlocks(typeNumber, _errorCorrectionLevel);
          var buffer = qrBitBuffer();

          for (var i = 0; i < _dataList.length; i++) {
            var data = _dataList[i];
            buffer.put(data.getMode(), 4);
            buffer.put(data.getLength(), QRUtil.getLengthInBits(data.getMode(), typeNumber) );
            data.write(buffer);
          }

          var totalDataCount = 0;
          for (var i = 0; i < rsBlocks.length; i++) {
            totalDataCount += rsBlocks[i].dataCount;
          }

          if (buffer.getLengthInBits() <= totalDataCount * 8) {
            break;
          }
        }

        _typeNumber = typeNumber;
      }

      makeImpl(false, getBestMaskPattern() );
    };

    _this.createTableTag = function(cellSize, margin) {

      cellSize = cellSize || 2;
      margin = (typeof margin == 'undefined')? cellSize * 4 : margin;

      var qrHtml = '';

      qrHtml += '<table style="';
      qrHtml += ' border-width: 0px; border-style: none;';
      qrHtml += ' border-collapse: collapse;';
      qrHtml += ' padding: 0px; margin: ' + margin + 'px;';
      qrHtml += '">';
      qrHtml += '<tbody>';

      for (var r = 0; r < _this.getModuleCount(); r += 1) {

        qrHtml += '<tr>';

        for (var c = 0; c < _this.getModuleCount(); c += 1) {
          qrHtml += '<td style="';
          qrHtml += ' border-width: 0px; border-style: none;';
          qrHtml += ' border-collapse: collapse;';
          qrHtml += ' padding: 0px; margin: 0px;';
          qrHtml += ' width: ' + cellSize + 'px;';
          qrHtml += ' height: ' + cellSize + 'px;';
          qrHtml += ' background-color: ';
          qrHtml += _this.isDark(r, c)? '#000000' : '#ffffff';
          qrHtml += ';';
          qrHtml += '"/>';
        }

        qrHtml += '</tr>';
      }

      qrHtml += '</tbody>';
      qrHtml += '</table>';

      return qrHtml;
    };

    _this.createSvgTag = function(cellSize, margin, alt, title) {

      var opts = {};
      if (typeof arguments[0] == 'object') {
        // Called by options.
        opts = arguments[0];
        // overwrite cellSize and margin.
        cellSize = opts.cellSize;
        margin = opts.margin;
        alt = opts.alt;
        title = opts.title;
      }

      cellSize = cellSize || 2;
      margin = (typeof margin == 'undefined')? cellSize * 4 : margin;

      // Compose alt property surrogate
      alt = (typeof alt === 'string') ? {text: alt} : alt || {};
      alt.text = alt.text || null;
      alt.id = (alt.text) ? alt.id || 'qrcode-description' : null;

      // Compose title property surrogate
      title = (typeof title === 'string') ? {text: title} : title || {};
      title.text = title.text || null;
      title.id = (title.text) ? title.id || 'qrcode-title' : null;

      var size = _this.getModuleCount() * cellSize + margin * 2;
      var c, mc, r, mr, qrSvg='', rect;

      rect = 'l' + cellSize + ',0 0,' + cellSize +
        ' -' + cellSize + ',0 0,-' + cellSize + 'z ';

      qrSvg += '<svg version="1.1" xmlns="http://www.w3.org/2000/svg"';
      qrSvg += !opts.scalable ? ' width="' + size + 'px" height="' + size + 'px"' : '';
      qrSvg += ' viewBox="0 0 ' + size + ' ' + size + '" ';
      qrSvg += ' preserveAspectRatio="xMinYMin meet"';
      qrSvg += (title.text || alt.text) ? ' role="img" aria-labelledby="' +
          escapeXml([title.id, alt.id].join(' ').trim() ) + '"' : '';
      qrSvg += '>';
      qrSvg += (title.text) ? '<title id="' + escapeXml(title.id) + '">' +
          escapeXml(title.text) + '</title>' : '';
      qrSvg += (alt.text) ? '<description id="' + escapeXml(alt.id) + '">' +
          escapeXml(alt.text) + '</description>' : '';
      qrSvg += '<rect width="100%" height="100%" fill="white" cx="0" cy="0"/>';
      qrSvg += '<path d="';

      for (r = 0; r < _this.getModuleCount(); r += 1) {
        mr = r * cellSize + margin;
        for (c = 0; c < _this.getModuleCount(); c += 1) {
          if (_this.isDark(r, c) ) {
            mc = c*cellSize+margin;
            qrSvg += 'M' + mc + ',' + mr + rect;
          }
        }
      }

      qrSvg += '" stroke="transparent" fill="black"/>';
      qrSvg += '</svg>';

      return qrSvg;
    };

    _this.createDataURL = function(cellSize, margin) {

      cellSize = cellSize || 2;
      margin = (typeof margin == 'undefined')? cellSize * 4 : margin;

      var size = _this.getModuleCount() * cellSize + margin * 2;
      var min = margin;
      var max = size - margin;

      return createDataURL(size, size, function(x, y) {
        if (min <= x && x < max && min <= y && y < max) {
          var c = Math.floor( (x - min) / cellSize);
          var r = Math.floor( (y - min) / cellSize);
          return _this.isDark(r, c)? 0 : 1;
        } else {
          return 1;
        }
      } );
    };

    _this.createImgTag = function(cellSize, margin, alt) {

      cellSize = cellSize || 2;
      margin = (typeof margin == 'undefined')? cellSize * 4 : margin;

      var size = _this.getModuleCount() * cellSize + margin * 2;

      var img = '';
      img += '<img';
      img += '\u0020src="';
      img += _this.createDataURL(cellSize, margin);
      img += '"';
      img += '\u0020width="';
      img += size;
      img += '"';
      img += '\u0020height="';
      img += size;
      img += '"';
      if (alt) {
        img += '\u0020alt="';
        img += escapeXml(alt);
        img += '"';
      }
      img += '/>';

      return img;
    };

    var escapeXml = function(s) {
      var escaped = '';
      for (var i = 0; i < s.length; i += 1) {
        var c = s.charAt(i);
        switch(c) {
        case '<': escaped += '&lt;'; break;
        case '>': escaped += '&gt;'; break;
        case '&': escaped += '&amp;'; break;
        case '"': escaped += '&quot;'; break;
        default : escaped += c; break;
        }
      }
      return escaped;
    };

    var _createHalfASCII = function(margin) {
      var cellSize = 1;
      margin = (typeof margin == 'undefined')? cellSize * 2 : margin;

      var size = _this.getModuleCount() * cellSize + margin * 2;
      var min = margin;
      var max = size - margin;

      var y, x, r1, r2, p;

      var blocks = {
        '██': '█',
        '█ ': '▀',
        ' █': '▄',
        '  ': ' '
      };

      var blocksLastLineNoMargin = {
        '██': '▀',
        '█ ': '▀',
        ' █': ' ',
        '  ': ' '
      };

      var ascii = '';
      for (y = 0; y < size; y += 2) {
        r1 = Math.floor((y - min) / cellSize);
        r2 = Math.floor((y + 1 - min) / cellSize);
        for (x = 0; x < size; x += 1) {
          p = '█';

          if (min <= x && x < max && min <= y && y < max && _this.isDark(r1, Math.floor((x - min) / cellSize))) {
            p = ' ';
          }

          if (min <= x && x < max && min <= y+1 && y+1 < max && _this.isDark(r2, Math.floor((x - min) / cellSize))) {
            p += ' ';
          }
          else {
            p += '█';
          }

          // Output 2 characters per pixel, to create full square. 1 character per pixels gives only half width of square.
          ascii += (margin < 1 && y+1 >= max) ? blocksLastLineNoMargin[p] : blocks[p];
        }

        ascii += '\n';
      }

      if (size % 2 && margin > 0) {
        return ascii.substring(0, ascii.length - size - 1) + Array(size+1).join('▀');
      }

      return ascii.substring(0, ascii.length-1);
    };

    _this.createASCII = function(cellSize, margin) {
      cellSize = cellSize || 1;

      if (cellSize < 2) {
        return _createHalfASCII(margin);
      }

      cellSize -= 1;
      margin = (typeof margin == 'undefined')? cellSize * 2 : margin;

      var size = _this.getModuleCount() * cellSize + margin * 2;
      var min = margin;
      var max = size - margin;

      var y, x, r, p;

      var white = Array(cellSize+1).join('██');
      var black = Array(cellSize+1).join('  ');

      var ascii = '';
      var line = '';
      for (y = 0; y < size; y += 1) {
        r = Math.floor( (y - min) / cellSize);
        line = '';
        for (x = 0; x < size; x += 1) {
          p = 1;

          if (min <= x && x < max && min <= y && y < max && _this.isDark(r, Math.floor((x - min) / cellSize))) {
            p = 0;
          }

          // Output 2 characters per pixel, to create full square. 1 character per pixels gives only half width of square.
          line += p ? white : black;
        }

        for (r = 0; r < cellSize; r += 1) {
          ascii += line + '\n';
        }
      }

      return ascii.substring(0, ascii.length-1);
    };

    _this.renderTo2dContext = function(context, cellSize) {
      cellSize = cellSize || 2;
      var length = _this.getModuleCount();
      for (var row = 0; row < length; row++) {
        for (var col = 0; col < length; col++) {
          context.fillStyle = _this.isDark(row, col) ? 'black' : 'white';
          context.fillRect(row * cellSize, col * cellSize, cellSize, cellSize);
        }
      }
    }

    return _this;
  };

  //---------------------------------------------------------------------
  // qrcode.stringToBytes
  //---------------------------------------------------------------------

  qrcode.stringToBytesFuncs = {
    'default' : function(s) {
      var bytes = [];
      for (var i = 0; i < s.length; i += 1) {
        var c = s.charCodeAt(i);
        bytes.push(c & 0xff);
      }
      return bytes;
    }
  };

  qrcode.stringToBytes = qrcode.stringToBytesFuncs['default'];

  //---------------------------------------------------------------------
  // qrcode.createStringToBytes
  //---------------------------------------------------------------------

  /**
   * @param unicodeData base64 string of byte array.
   * [16bit Unicode],[16bit Bytes], ...
   * @param numChars
   */
  qrcode.createStringToBytes = function(unicodeData, numChars) {

    // create conversion map.

    var unicodeMap = function() {

      var bin = base64DecodeInputStream(unicodeData);
      var read = function() {
        var b = bin.read();
        if (b == -1) throw 'eof';
        return b;
      };

      var count = 0;
      var unicodeMap = {};
      while (true) {
        var b0 = bin.read();
        if (b0 == -1) break;
        var b1 = read();
        var b2 = read();
        var b3 = read();
        var k = String.fromCharCode( (b0 << 8) | b1);
        var v = (b2 << 8) | b3;
        unicodeMap[k] = v;
        count += 1;
      }
      if (count != numChars) {
        throw count + ' != ' + numChars;
      }

      return unicodeMap;
    }();

    var unknownChar = '?'.charCodeAt(0);

    return function(s) {
      var bytes = [];
      for (var i = 0; i < s.length; i += 1) {
        var c = s.charCodeAt(i);
        if (c < 128) {
          bytes.push(c);
        } else {
          var b = unicodeMap[s.charAt(i)];
          if (typeof b == 'number') {
            if ( (b & 0xff) == b) {
              // 1byte
              bytes.push(b);
            } else {
              // 2bytes
              bytes.push(b >>> 8);
              bytes.push(b & 0xff);
            }
          } else {
            bytes.push(unknownChar);
          }
        }
      }
      return bytes;
    };
  };

  //---------------------------------------------------------------------
  // QRMode
  //---------------------------------------------------------------------

  var QRMode = {
    MODE_NUMBER :    1 << 0,
    MODE_ALPHA_NUM : 1 << 1,
    MODE_8BIT_BYTE : 1 << 2,
    MODE_KANJI :     1 << 3
  };

  //---------------------------------------------------------------------
  // QRErrorCorrectionLevel
  //---------------------------------------------------------------------

  var QRErrorCorrectionLevel = {
    L : 1,
    M : 0,
    Q : 3,
    H : 2
  };

  //---------------------------------------------------------------------
  // QRMaskPattern
  //---------------------------------------------------------------------

  var QRMaskPattern = {
    PATTERN000 : 0,
    PATTERN001 : 1,
    PATTERN010 : 2,
    PATTERN011 : 3,
    PATTERN100 : 4,
    PATTERN101 : 5,
    PATTERN110 : 6,
    PATTERN111 : 7
  };

  //---------------------------------------------------------------------
  // QRUtil
  //---------------------------------------------------------------------

  var QRUtil = function() {

    var PATTERN_POSITION_TABLE = [
      [],
      [6, 18],
      [6, 22],
      [6, 26],
      [6, 30],
      [6, 34],
      [6, 22, 38],
      [6, 24, 42],
      [6, 26, 46],
      [6, 28, 50],
      [6, 30, 54],
      [6, 32, 58],
      [6, 34, 62],
      [6, 26, 46, 66],
      [6, 26, 48, 70],
      [6, 26, 50, 74],
      [6, 30, 54, 78],
      [6, 30, 56, 82],
      [6, 30, 58, 86],
      [6, 34, 62, 90],
      [6, 28, 50, 72, 94],
      [6, 26, 50, 74, 98],
      [6, 30, 54, 78, 102],
      [6, 28, 54, 80, 106],
      [6, 32, 58, 84, 110],
      [6, 30, 58, 86, 114],
      [6, 34, 62, 90, 118],
      [6, 26, 50, 74, 98, 122],
      [6, 30, 54, 78, 102, 126],
      [6, 26, 52, 78, 104, 130],
      [6, 30, 56, 82, 108, 134],
      [6, 34, 60, 86, 112, 138],
      [6, 30, 58, 86, 114, 142],
      [6, 34, 62, 90, 118, 146],
      [6, 30, 54, 78, 102, 126, 150],
      [6, 24, 50, 76, 102, 128, 154],
      [6, 28, 54, 80, 106, 132, 158],
      [6, 32, 58, 84, 110, 136, 162],
      [6, 26, 54, 82, 110, 138, 166],
      [6, 30, 58, 86, 114, 142, 170]
    ];
    var G15 = (1 << 10) | (1 << 8) | (1 << 5) | (1 << 4) | (1 << 2) | (1 << 1) | (1 << 0);
    var G18 = (1 << 12) | (1 << 11) | (1 << 10) | (1 << 9) | (1 << 8) | (1 << 5) | (1 << 2) | (1 << 0);
    var G15_MASK = (1 << 14) | (1 << 12) | (1 << 10) | (1 << 4) | (1 << 1);

    var _this = {};

    var getBCHDigit = function(data) {
      var digit = 0;
      while (data != 0) {
        digit += 1;
        data >>>= 1;
      }
      return digit;
    };

    _this.getBCHTypeInfo = function(data) {
      var d = data << 10;
      while (getBCHDigit(d) - getBCHDigit(G15) >= 0) {
        d ^= (G15 << (getBCHDigit(d) - getBCHDigit(G15) ) );
      }
      return ( (data << 10) | d) ^ G15_MASK;
    };

    _this.getBCHTypeNumber = function(data) {
      var d = data << 12;
      while (getBCHDigit(d) - getBCHDigit(G18) >= 0) {
        d ^= (G18 << (getBCHDigit(d) - getBCHDigit(G18) ) );
      }
      return (data << 12) | d;
    };

    _this.getPatternPosition = function(typeNumber) {
      return PATTERN_POSITION_TABLE[typeNumber - 1];
    };

    _this.getMaskFunction = function(maskPattern) {

      switch (maskPattern) {

      case QRMaskPattern.PATTERN000 :
        return function(i, j) { return (i + j) % 2 == 0; };
      case QRMaskPattern.PATTERN001 :
        return function(i, j) { return i % 2 == 0; };
      case QRMaskPattern.PATTERN010 :
        return function(i, j) { return j % 3 == 0; };
      case QRMaskPattern.PATTERN011 :
        return function(i, j) { return (i + j) % 3 == 0; };
      case QRMaskPattern.PATTERN100 :
        return function(i, j) { return (Math.floor(i / 2) + Math.floor(j / 3) ) % 2 == 0; };
      case QRMaskPattern.PATTERN101 :
        return function(i, j) { return (i * j) % 2 + (i * j) % 3 == 0; };
      case QRMaskPattern.PATTERN110 :
        return function(i, j) { return ( (i * j) % 2 + (i * j) % 3) % 2 == 0; };
      case QRMaskPattern.PATTERN111 :
        return function(i, j) { return ( (i * j) % 3 + (i + j) % 2) % 2 == 0; };

      default :
        throw 'bad maskPattern:' + maskPattern;
      }
    };

    _this.getErrorCorrectPolynomial = function(errorCorrectLength) {
      var a = qrPolynomial([1], 0);
      for (var i = 0; i < errorCorrectLength; i += 1) {
        a = a.multiply(qrPolynomial([1, QRMath.gexp(i)], 0) );
      }
      return a;
    };

    _this.getLengthInBits = function(mode, type) {

      if (1 <= type && type < 10) {

        // 1 - 9

        switch(mode) {
        case QRMode.MODE_NUMBER    : return 10;
        case QRMode.MODE_ALPHA_NUM : return 9;
        case QRMode.MODE_8BIT_BYTE : return 8;
        case QRMode.MODE_KANJI     : return 8;
        default :
          throw 'mode:' + mode;
        }

      } else if (type < 27) {

        // 10 - 26

        switch(mode) {
        case QRMode.MODE_NUMBER    : return 12;
        case QRMode.MODE_ALPHA_NUM : return 11;
        case QRMode.MODE_8BIT_BYTE : return 16;
        case QRMode.MODE_KANJI     : return 10;
        default :
          throw 'mode:' + mode;
        }

      } else if (type < 41) {

        // 27 - 40

        switch(mode) {
        case QRMode.MODE_NUMBER    : return 14;
        case QRMode.MODE_ALPHA_NUM : return 13;
        case QRMode.MODE_8BIT_BYTE : return 16;
        case QRMode.MODE_KANJI     : return 12;
        default :
          throw 'mode:' + mode;
        }

      } else {
        throw 'type:' + type;
      }
    };

    _this.getLostPoint = function(qrcode) {

      var moduleCount = qrcode.getModuleCount();

      var lostPoint = 0;

      // LEVEL1

      for (var row = 0; row < moduleCount; row += 1) {
        for (var col = 0; col < moduleCount; col += 1) {

          var sameCount = 0;
          var dark = qrcode.isDark(row, col);

          for (var r = -1; r <= 1; r += 1) {

            if (row + r < 0 || moduleCount <= row + r) {
              continue;
            }

            for (var c = -1; c <= 1; c += 1) {

              if (col + c < 0 || moduleCount <= col + c) {
                continue;
              }

              if (r == 0 && c == 0) {
                continue;
              }

              if (dark == qrcode.isDark(row + r, col + c) ) {
                sameCount += 1;
              }
            }
          }

          if (sameCount > 5) {
            lostPoint += (3 + sameCount - 5);
          }
        }
      };

      // LEVEL2

      for (var row = 0; row < moduleCount - 1; row += 1) {
        for (var col = 0; col < moduleCount - 1; col += 1) {
          var count = 0;
          if (qrcode.isDark(row, col) ) count += 1;
          if (qrcode.isDark(row + 1, col) ) count += 1;
          if (qrcode.isDark(row, col + 1) ) count += 1;
          if (qrcode.isDark(row + 1, col + 1) ) count += 1;
          if (count == 0 || count == 4) {
            lostPoint += 3;
          }
        }
      }

      // LEVEL3

      for (var row = 0; row < moduleCount; row += 1) {
        for (var col = 0; col < moduleCount - 6; col += 1) {
          if (qrcode.isDark(row, col)
              && !qrcode.isDark(row, col + 1)
              &&  qrcode.isDark(row, col + 2)
              &&  qrcode.isDark(row, col + 3)
              &&  qrcode.isDark(row, col + 4)
              && !qrcode.isDark(row, col + 5)
              &&  qrcode.isDark(row, col + 6) ) {
            lostPoint += 40;
          }
        }
      }

      for (var col = 0; col < moduleCount; col += 1) {
        for (var row = 0; row < moduleCount - 6; row += 1) {
          if (qrcode.isDark(row, col)
              && !qrcode.isDark(row + 1, col)
              &&  qrcode.isDark(row + 2, col)
              &&  qrcode.isDark(row + 3, col)
              &&  qrcode.isDark(row + 4, col)
              && !qrcode.isDark(row + 5, col)
              &&  qrcode.isDark(row + 6, col) ) {
            lostPoint += 40;
          }
        }
      }

      // LEVEL4

      var darkCount = 0;

      for (var col = 0; col < moduleCount; col += 1) {
        for (var row = 0; row < moduleCount; row += 1) {
          if (qrcode.isDark(row, col) ) {
            darkCount += 1;
          }
        }
      }

      var ratio = Math.abs(100 * darkCount / moduleCount / moduleCount - 50) / 5;
      lostPoint += ratio * 10;

      return lostPoint;
    };

    return _this;
  }();

  //---------------------------------------------------------------------
  // QRMath
  //---------------------------------------------------------------------

  var QRMath = function() {

    var EXP_TABLE = new Array(256);
    var LOG_TABLE = new Array(256);

    // initialize tables
    for (var i = 0; i < 8; i += 1) {
      EXP_TABLE[i] = 1 << i;
    }
    for (var i = 8; i < 256; i += 1) {
      EXP_TABLE[i] = EXP_TABLE[i - 4]
        ^ EXP_TABLE[i - 5]
        ^ EXP_TABLE[i - 6]
        ^ EXP_TABLE[i - 8];
    }
    for (var i = 0; i < 255; i += 1) {
      LOG_TABLE[EXP_TABLE[i] ] = i;
    }

    var _this = {};

    _this.glog = function(n) {

      if (n < 1) {
        throw 'glog(' + n + ')';
      }

      return LOG_TABLE[n];
    };

    _this.gexp = function(n) {

      while (n < 0) {
        n += 255;
      }

      while (n >= 256) {
        n -= 255;
      }

      return EXP_TABLE[n];
    };

    return _this;
  }();

  //---------------------------------------------------------------------
  // qrPolynomial
  //---------------------------------------------------------------------

  function qrPolynomial(num, shift) {

    if (typeof num.length == 'undefined') {
      throw num.length + '/' + shift;
    }

    var _num = function() {
      var offset = 0;
      while (offset < num.length && num[offset] == 0) {
        offset += 1;
      }
      var _num = new Array(num.length - offset + shift);
      for (var i = 0; i < num.length - offset; i += 1) {
        _num[i] = num[i + offset];
      }
      return _num;
    }();

    var _this = {};

    _this.getAt = function(index) {
      return _num[index];
    };

    _this.getLength = function() {
      return _num.length;
    };

    _this.multiply = function(e) {

      var num = new Array(_this.getLength() + e.getLength() - 1);

      for (var i = 0; i < _this.getLength(); i += 1) {
        for (var j = 0; j < e.getLength(); j += 1) {
          num[i + j] ^= QRMath.gexp(QRMath.glog(_this.getAt(i) ) + QRMath.glog(e.getAt(j) ) );
        }
      }

      return qrPolynomial(num, 0);
    };

    _this.mod = function(e) {

      if (_this.getLength() - e.getLength() < 0) {
        return _this;
      }

      var ratio = QRMath.glog(_this.getAt(0) ) - QRMath.glog(e.getAt(0) );

      var num = new Array(_this.getLength() );
      for (var i = 0; i < _this.getLength(); i += 1) {
        num[i] = _this.getAt(i);
      }

      for (var i = 0; i < e.getLength(); i += 1) {
        num[i] ^= QRMath.gexp(QRMath.glog(e.getAt(i) ) + ratio);
      }

      // recursive call
      return qrPolynomial(num, 0).mod(e);
    };

    return _this;
  };

  //---------------------------------------------------------------------
  // QRRSBlock
  //---------------------------------------------------------------------

  var QRRSBlock = function() {

    var RS_BLOCK_TABLE = [

      // L
      // M
      // Q
      // H

      // 1
      [1, 26, 19],
      [1, 26, 16],
      [1, 26, 13],
      [1, 26, 9],

      // 2
      [1, 44, 34],
      [1, 44, 28],
      [1, 44, 22],
      [1, 44, 16],

      // 3
      [1, 70, 55],
      [1, 70, 44],
      [2, 35, 17],
      [2, 35, 13],

      // 4
      [1, 100, 80],
      [2, 50, 32],
      [2, 50, 24],
      [4, 25, 9],

      // 5
      [1, 134, 108],
      [2, 67, 43],
      [2, 33, 15, 2, 34, 16],
      [2, 33, 11, 2, 34, 12],

      // 6
      [2, 86, 68],
      [4, 43, 27],
      [4, 43, 19],
      [4, 43, 15],

      // 7
      [2, 98, 78],
      [4, 49, 31],
      [2, 32, 14, 4, 33, 15],
      [4, 39, 13, 1, 40, 14],

      // 8
      [2, 121, 97],
      [2, 60, 38, 2, 61, 39],
      [4, 40, 18, 2, 41, 19],
      [4, 40, 14, 2, 41, 15],

      // 9
      [2, 146, 116],
      [3, 58, 36, 2, 59, 37],
      [4, 36, 16, 4, 37, 17],
      [4, 36, 12, 4, 37, 13],

      // 10
      [2, 86, 68, 2, 87, 69],
      [4, 69, 43, 1, 70, 44],
      [6, 43, 19, 2, 44, 20],
      [6, 43, 15, 2, 44, 16],

      // 11
      [4, 101, 81],
      [1, 80, 50, 4, 81, 51],
      [4, 50, 22, 4, 51, 23],
      [3, 36, 12, 8, 37, 13],

      // 12
      [2, 116, 92, 2, 117, 93],
      [6, 58, 36, 2, 59, 37],
      [4, 46, 20, 6, 47, 21],
      [7, 42, 14, 4, 43, 15],

      // 13
      [4, 133, 107],
      [8, 59, 37, 1, 60, 38],
      [8, 44, 20, 4, 45, 21],
      [12, 33, 11, 4, 34, 12],

      // 14
      [3, 145, 115, 1, 146, 116],
      [4, 64, 40, 5, 65, 41],
      [11, 36, 16, 5, 37, 17],
      [11, 36, 12, 5, 37, 13],

      // 15
      [5, 109, 87, 1, 110, 88],
      [5, 65, 41, 5, 66, 42],
      [5, 54, 24, 7, 55, 25],
      [11, 36, 12, 7, 37, 13],

      // 16
      [5, 122, 98, 1, 123, 99],
      [7, 73, 45, 3, 74, 46],
      [15, 43, 19, 2, 44, 20],
      [3, 45, 15, 13, 46, 16],

      // 17
      [1, 135, 107, 5, 136, 108],
      [10, 74, 46, 1, 75, 47],
      [1, 50, 22, 15, 51, 23],
      [2, 42, 14, 17, 43, 15],

      // 18
      [5, 150, 120, 1, 151, 121],
      [9, 69, 43, 4, 70, 44],
      [17, 50, 22, 1, 51, 23],
      [2, 42, 14, 19, 43, 15],

      // 19
      [3, 141, 113, 4, 142, 114],
      [3, 70, 44, 11, 71, 45],
      [17, 47, 21, 4, 48, 22],
      [9, 39, 13, 16, 40, 14],

      // 20
      [3, 135, 107, 5, 136, 108],
      [3, 67, 41, 13, 68, 42],
      [15, 54, 24, 5, 55, 25],
      [15, 43, 15, 10, 44, 16],

      // 21
      [4, 144, 116, 4, 145, 117],
      [17, 68, 42],
      [17, 50, 22, 6, 51, 23],
      [19, 46, 16, 6, 47, 17],

      // 22
      [2, 139, 111, 7, 140, 112],
      [17, 74, 46],
      [7, 54, 24, 16, 55, 25],
      [34, 37, 13],

      // 23
      [4, 151, 121, 5, 152, 122],
      [4, 75, 47, 14, 76, 48],
      [11, 54, 24, 14, 55, 25],
      [16, 45, 15, 14, 46, 16],

      // 24
      [6, 147, 117, 4, 148, 118],
      [6, 73, 45, 14, 74, 46],
      [11, 54, 24, 16, 55, 25],
      [30, 46, 16, 2, 47, 17],

      // 25
      [8, 132, 106, 4, 133, 107],
      [8, 75, 47, 13, 76, 48],
      [7, 54, 24, 22, 55, 25],
      [22, 45, 15, 13, 46, 16],

      // 26
      [10, 142, 114, 2, 143, 115],
      [19, 74, 46, 4, 75, 47],
      [28, 50, 22, 6, 51, 23],
      [33, 46, 16, 4, 47, 17],

      // 27
      [8, 152, 122, 4, 153, 123],
      [22, 73, 45, 3, 74, 46],
      [8, 53, 23, 26, 54, 24],
      [12, 45, 15, 28, 46, 16],

      // 28
      [3, 147, 117, 10, 148, 118],
      [3, 73, 45, 23, 74, 46],
      [4, 54, 24, 31, 55, 25],
      [11, 45, 15, 31, 46, 16],

      // 29
      [7, 146, 116, 7, 147, 117],
      [21, 73, 45, 7, 74, 46],
      [1, 53, 23, 37, 54, 24],
      [19, 45, 15, 26, 46, 16],

      // 30
      [5, 145, 115, 10, 146, 116],
      [19, 75, 47, 10, 76, 48],
      [15, 54, 24, 25, 55, 25],
      [23, 45, 15, 25, 46, 16],

      // 31
      [13, 145, 115, 3, 146, 116],
      [2, 74, 46, 29, 75, 47],
      [42, 54, 24, 1, 55, 25],
      [23, 45, 15, 28, 46, 16],

      // 32
      [17, 145, 115],
      [10, 74, 46, 23, 75, 47],
      [10, 54, 24, 35, 55, 25],
      [19, 45, 15, 35, 46, 16],

      // 33
      [17, 145, 115, 1, 146, 116],
      [14, 74, 46, 21, 75, 47],
      [29, 54, 24, 19, 55, 25],
      [11, 45, 15, 46, 46, 16],

      // 34
      [13, 145, 115, 6, 146, 116],
      [14, 74, 46, 23, 75, 47],
      [44, 54, 24, 7, 55, 25],
      [59, 46, 16, 1, 47, 17],

      // 35
      [12, 151, 121, 7, 152, 122],
      [12, 75, 47, 26, 76, 48],
      [39, 54, 24, 14, 55, 25],
      [22, 45, 15, 41, 46, 16],

      // 36
      [6, 151, 121, 14, 152, 122],
      [6, 75, 47, 34, 76, 48],
      [46, 54, 24, 10, 55, 25],
      [2, 45, 15, 64, 46, 16],

      // 37
      [17, 152, 122, 4, 153, 123],
      [29, 74, 46, 14, 75, 47],
      [49, 54, 24, 10, 55, 25],
      [24, 45, 15, 46, 46, 16],

      // 38
      [4, 152, 122, 18, 153, 123],
      [13, 74, 46, 32, 75, 47],
      [48, 54, 24, 14, 55, 25],
      [42, 45, 15, 32, 46, 16],

      // 39
      [20, 147, 117, 4, 148, 118],
      [40, 75, 47, 7, 76, 48],
      [43, 54, 24, 22, 55, 25],
      [10, 45, 15, 67, 46, 16],

      // 40
      [19, 148, 118, 6, 149, 119],
      [18, 75, 47, 31, 76, 48],
      [34, 54, 24, 34, 55, 25],
      [20, 45, 15, 61, 46, 16]
    ];

    var qrRSBlock = function(totalCount, dataCount) {
      var _this = {};
      _this.totalCount = totalCount;
      _this.dataCount = dataCount;
      return _this;
    };

    var _this = {};

    var getRsBlockTable = function(typeNumber, errorCorrectionLevel) {

      switch(errorCorrectionLevel) {
      case QRErrorCorrectionLevel.L :
        return RS_BLOCK_TABLE[(typeNumber - 1) * 4 + 0];
      case QRErrorCorrectionLevel.M :
        return RS_BLOCK_TABLE[(typeNumber - 1) * 4 + 1];
      case QRErrorCorrectionLevel.Q :
        return RS_BLOCK_TABLE[(typeNumber - 1) * 4 + 2];
      case QRErrorCorrectionLevel.H :
        return RS_BLOCK_TABLE[(typeNumber - 1) * 4 + 3];
      default :
        return undefined;
      }
    };

    _this.getRSBlocks = function(typeNumber, errorCorrectionLevel) {

      var rsBlock = getRsBlockTable(typeNumber, errorCorrectionLevel);

      if (typeof rsBlock == 'undefined') {
        throw 'bad rs block @ typeNumber:' + typeNumber +
            '/errorCorrectionLevel:' + errorCorrectionLevel;
      }

      var length = rsBlock.length / 3;

      var list = [];

      for (var i = 0; i < length; i += 1) {

        var count = rsBlock[i * 3 + 0];
        var totalCount = rsBlock[i * 3 + 1];
        var dataCount = rsBlock[i * 3 + 2];

        for (var j = 0; j < count; j += 1) {
          list.push(qrRSBlock(totalCount, dataCount) );
        }
      }

      return list;
    };

    return _this;
  }();

  //---------------------------------------------------------------------
  // qrBitBuffer
  //---------------------------------------------------------------------

  var qrBitBuffer = function() {

    var _buffer = [];
    var _length = 0;

    var _this = {};

    _this.getBuffer = function() {
      return _buffer;
    };

    _this.getAt = function(index) {
      var bufIndex = Math.floor(index / 8);
      return ( (_buffer[bufIndex] >>> (7 - index % 8) ) & 1) == 1;
    };

    _this.put = function(num, length) {
      for (var i = 0; i < length; i += 1) {
        _this.putBit( ( (num >>> (length - i - 1) ) & 1) == 1);
      }
    };

    _this.getLengthInBits = function() {
      return _length;
    };

    _this.putBit = function(bit) {

      var bufIndex = Math.floor(_length / 8);
      if (_buffer.length <= bufIndex) {
        _buffer.push(0);
      }

      if (bit) {
        _buffer[bufIndex] |= (0x80 >>> (_length % 8) );
      }

      _length += 1;
    };

    return _this;
  };

  //---------------------------------------------------------------------
  // qrNumber
  //---------------------------------------------------------------------

  var qrNumber = function(data) {

    var _mode = QRMode.MODE_NUMBER;
    var _data = data;

    var _this = {};

    _this.getMode = function() {
      return _mode;
    };

    _this.getLength = function(buffer) {
      return _data.length;
    };

    _this.write = function(buffer) {

      var data = _data;

      var i = 0;

      while (i + 2 < data.length) {
        buffer.put(strToNum(data.substring(i, i + 3) ), 10);
        i += 3;
      }

      if (i < data.length) {
        if (data.length - i == 1) {
          buffer.put(strToNum(data.substring(i, i + 1) ), 4);
        } else if (data.length - i == 2) {
          buffer.put(strToNum(data.substring(i, i + 2) ), 7);
        }
      }
    };

    var strToNum = function(s) {
      var num = 0;
      for (var i = 0; i < s.length; i += 1) {
        num = num * 10 + chatToNum(s.charAt(i) );
      }
      return num;
    };

    var chatToNum = function(c) {
      if ('0' <= c && c <= '9') {
        return c.charCodeAt(0) - '0'.charCodeAt(0);
      }
      throw 'illegal char :' + c;
    };

    return _this;
  };

  //---------------------------------------------------------------------
  // qrAlphaNum
  //---------------------------------------------------------------------

  var qrAlphaNum = function(data) {

    var _mode = QRMode.MODE_ALPHA_NUM;
    var _data = data;

    var _this = {};

    _this.getMode = function() {
      return _mode;
    };

    _this.getLength = function(buffer) {
      return _data.length;
    };

    _this.write = function(buffer) {

      var s = _data;

      var i = 0;

      while (i + 1 < s.length) {
        buffer.put(
          getCode(s.charAt(i) ) * 45 +
          getCode(s.charAt(i + 1) ), 11);
        i += 2;
      }

      if (i < s.length) {
        buffer.put(getCode(s.charAt(i) ), 6);
      }
    };

    var getCode = function(c) {

      if ('0' <= c && c <= '9') {
        return c.charCodeAt(0) - '0'.charCodeAt(0);
      } else if ('A' <= c && c <= 'Z') {
        return c.charCodeAt(0) - 'A'.charCodeAt(0) + 10;
      } else {
        switch (c) {
        case ' ' : return 36;
        case '$' : return 37;
        case '%' : return 38;
        case '*' : return 39;
        case '+' : return 40;
        case '-' : return 41;
        case '.' : return 42;
        case '/' : return 43;
        case ':' : return 44;
        default :
          throw 'illegal char :' + c;
        }
      }
    };

    return _this;
  };

  //---------------------------------------------------------------------
  // qr8BitByte
  //---------------------------------------------------------------------

  var qr8BitByte = function(data) {

    var _mode = QRMode.MODE_8BIT_BYTE;
    var _data = data;
    var _bytes = qrcode.stringToBytes(data);

    var _this = {};

    _this.getMode = function() {
      return _mode;
    };

    _this.getLength = function(buffer) {
      return _bytes.length;
    };

    _this.write = function(buffer) {
      for (var i = 0; i < _bytes.length; i += 1) {
        buffer.put(_bytes[i], 8);
      }
    };

    return _this;
  };

  //---------------------------------------------------------------------
  // qrKanji
  //---------------------------------------------------------------------

  var qrKanji = function(data) {

    var _mode = QRMode.MODE_KANJI;
    var _data = data;

    var stringToBytes = qrcode.stringToBytesFuncs['SJIS'];
    if (!stringToBytes) {
      throw 'sjis not supported.';
    }
    !function(c, code) {
      // self test for sjis support.
      var test = stringToBytes(c);
      if (test.length != 2 || ( (test[0] << 8) | test[1]) != code) {
        throw 'sjis not supported.';
      }
    }('\u53cb', 0x9746);

    var _bytes = stringToBytes(data);

    var _this = {};

    _this.getMode = function() {
      return _mode;
    };

    _this.getLength = function(buffer) {
      return ~~(_bytes.length / 2);
    };

    _this.write = function(buffer) {

      var data = _bytes;

      var i = 0;

      while (i + 1 < data.length) {

        var c = ( (0xff & data[i]) << 8) | (0xff & data[i + 1]);

        if (0x8140 <= c && c <= 0x9FFC) {
          c -= 0x8140;
        } else if (0xE040 <= c && c <= 0xEBBF) {
          c -= 0xC140;
        } else {
          throw 'illegal char at ' + (i + 1) + '/' + c;
        }

        c = ( (c >>> 8) & 0xff) * 0xC0 + (c & 0xff);

        buffer.put(c, 13);

        i += 2;
      }

      if (i < data.length) {
        throw 'illegal char at ' + (i + 1);
      }
    };

    return _this;
  };

  //=====================================================================
  // GIF Support etc.
  //

  //---------------------------------------------------------------------
  // byteArrayOutputStream
  //---------------------------------------------------------------------

  var byteArrayOutputStream = function() {

    var _bytes = [];

    var _this = {};

    _this.writeByte = function(b) {
      _bytes.push(b & 0xff);
    };

    _this.writeShort = function(i) {
      _this.writeByte(i);
      _this.writeByte(i >>> 8);
    };

    _this.writeBytes = function(b, off, len) {
      off = off || 0;
      len = len || b.length;
      for (var i = 0; i < len; i += 1) {
        _this.writeByte(b[i + off]);
      }
    };

    _this.writeString = function(s) {
      for (var i = 0; i < s.length; i += 1) {
        _this.writeByte(s.charCodeAt(i) );
      }
    };

    _this.toByteArray = function() {
      return _bytes;
    };

    _this.toString = function() {
      var s = '';
      s += '[';
      for (var i = 0; i < _bytes.length; i += 1) {
        if (i > 0) {
          s += ',';
        }
        s += _bytes[i];
      }
      s += ']';
      return s;
    };

    return _this;
  };

  //---------------------------------------------------------------------
  // base64EncodeOutputStream
  //---------------------------------------------------------------------

  var base64EncodeOutputStream = function() {

    var _buffer = 0;
    var _buflen = 0;
    var _length = 0;
    var _base64 = '';

    var _this = {};

    var writeEncoded = function(b) {
      _base64 += String.fromCharCode(encode(b & 0x3f) );
    };

    var encode = function(n) {
      if (n < 0) {
        // error.
      } else if (n < 26) {
        return 0x41 + n;
      } else if (n < 52) {
        return 0x61 + (n - 26);
      } else if (n < 62) {
        return 0x30 + (n - 52);
      } else if (n == 62) {
        return 0x2b;
      } else if (n == 63) {
        return 0x2f;
      }
      throw 'n:' + n;
    };

    _this.writeByte = function(n) {

      _buffer = (_buffer << 8) | (n & 0xff);
      _buflen += 8;
      _length += 1;

      while (_buflen >= 6) {
        writeEncoded(_buffer >>> (_buflen - 6) );
        _buflen -= 6;
      }
    };

    _this.flush = function() {

      if (_buflen > 0) {
        writeEncoded(_buffer << (6 - _buflen) );
        _buffer = 0;
        _buflen = 0;
      }

      if (_length % 3 != 0) {
        // padding
        var padlen = 3 - _length % 3;
        for (var i = 0; i < padlen; i += 1) {
          _base64 += '=';
        }
      }
    };

    _this.toString = function() {
      return _base64;
    };

    return _this;
  };

  //---------------------------------------------------------------------
  // base64DecodeInputStream
  //---------------------------------------------------------------------

  var base64DecodeInputStream = function(str) {

    var _str = str;
    var _pos = 0;
    var _buffer = 0;
    var _buflen = 0;

    var _this = {};

    _this.read = function() {

      while (_buflen < 8) {

        if (_pos >= _str.length) {
          if (_buflen == 0) {
            return -1;
          }
          throw 'unexpected end of file./' + _buflen;
        }

        var c = _str.charAt(_pos);
        _pos += 1;

        if (c == '=') {
          _buflen = 0;
          return -1;
        } else if (c.match(/^\s$/) ) {
          // ignore if whitespace.
          continue;
        }

        _buffer = (_buffer << 6) | decode(c.charCodeAt(0) );
        _buflen += 6;
      }

      var n = (_buffer >>> (_buflen - 8) ) & 0xff;
      _buflen -= 8;
      return n;
    };

    var decode = function(c) {
      if (0x41 <= c && c <= 0x5a) {
        return c - 0x41;
      } else if (0x61 <= c && c <= 0x7a) {
        return c - 0x61 + 26;
      } else if (0x30 <= c && c <= 0x39) {
        return c - 0x30 + 52;
      } else if (c == 0x2b) {
        return 62;
      } else if (c == 0x2f) {
        return 63;
      } else {
        throw 'c:' + c;
      }
    };

    return _this;
  };

  //---------------------------------------------------------------------
  // gifImage (B/W)
  //---------------------------------------------------------------------

  var gifImage = function(width, height) {

    var _width = width;
    var _height = height;
    var _data = new Array(width * height);

    var _this = {};

    _this.setPixel = function(x, y, pixel) {
      _data[y * _width + x] = pixel;
    };

    _this.write = function(out) {

      //---------------------------------
      // GIF Signature

      out.writeString('GIF87a');

      //---------------------------------
      // Screen Descriptor

      out.writeShort(_width);
      out.writeShort(_height);

      out.writeByte(0x80); // 2bit
      out.writeByte(0);
      out.writeByte(0);

      //---------------------------------
      // Global Color Map

      // black
      out.writeByte(0x00);
      out.writeByte(0x00);
      out.writeByte(0x00);

      // white
      out.writeByte(0xff);
      out.writeByte(0xff);
      out.writeByte(0xff);

      //---------------------------------
      // Image Descriptor

      out.writeString(',');
      out.writeShort(0);
      out.writeShort(0);
      out.writeShort(_width);
      out.writeShort(_height);
      out.writeByte(0);

      //---------------------------------
      // Local Color Map

      //---------------------------------
      // Raster Data

      var lzwMinCodeSize = 2;
      var raster = getLZWRaster(lzwMinCodeSize);

      out.writeByte(lzwMinCodeSize);

      var offset = 0;

      while (raster.length - offset > 255) {
        out.writeByte(255);
        out.writeBytes(raster, offset, 255);
        offset += 255;
      }

      out.writeByte(raster.length - offset);
      out.writeBytes(raster, offset, raster.length - offset);
      out.writeByte(0x00);

      //---------------------------------
      // GIF Terminator
      out.writeString(';');
    };

    var bitOutputStream = function(out) {

      var _out = out;
      var _bitLength = 0;
      var _bitBuffer = 0;

      var _this = {};

      _this.write = function(data, length) {

        if ( (data >>> length) != 0) {
          throw 'length over';
        }

        while (_bitLength + length >= 8) {
          _out.writeByte(0xff & ( (data << _bitLength) | _bitBuffer) );
          length -= (8 - _bitLength);
          data >>>= (8 - _bitLength);
          _bitBuffer = 0;
          _bitLength = 0;
        }

        _bitBuffer = (data << _bitLength) | _bitBuffer;
        _bitLength = _bitLength + length;
      };

      _this.flush = function() {
        if (_bitLength > 0) {
          _out.writeByte(_bitBuffer);
        }
      };

      return _this;
    };

    var getLZWRaster = function(lzwMinCodeSize) {

      var clearCode = 1 << lzwMinCodeSize;
      var endCode = (1 << lzwMinCodeSize) + 1;
      var bitLength = lzwMinCodeSize + 1;

      // Setup LZWTable
      var table = lzwTable();

      for (var i = 0; i < clearCode; i += 1) {
        table.add(String.fromCharCode(i) );
      }
      table.add(String.fromCharCode(clearCode) );
      table.add(String.fromCharCode(endCode) );

      var byteOut = byteArrayOutputStream();
      var bitOut = bitOutputStream(byteOut);

      // clear code
      bitOut.write(clearCode, bitLength);

      var dataIndex = 0;

      var s = String.fromCharCode(_data[dataIndex]);
      dataIndex += 1;

      while (dataIndex < _data.length) {

        var c = String.fromCharCode(_data[dataIndex]);
        dataIndex += 1;

        if (table.contains(s + c) ) {

          s = s + c;

        } else {

          bitOut.write(table.indexOf(s), bitLength);

          if (table.size() < 0xfff) {

            if (table.size() == (1 << bitLength) ) {
              bitLength += 1;
            }

            table.add(s + c);
          }

          s = c;
        }
      }

      bitOut.write(table.indexOf(s), bitLength);

      // end code
      bitOut.write(endCode, bitLength);

      bitOut.flush();

      return byteOut.toByteArray();
    };

    var lzwTable = function() {

      var _map = {};
      var _size = 0;

      var _this = {};

      _this.add = function(key) {
        if (_this.contains(key) ) {
          throw 'dup key:' + key;
        }
        _map[key] = _size;
        _size += 1;
      };

      _this.size = function() {
        return _size;
      };

      _this.indexOf = function(key) {
        return _map[key];
      };

      _this.contains = function(key) {
        return typeof _map[key] != 'undefined';
      };

      return _this;
    };

    return _this;
  };

  var createDataURL = function(width, height, getPixel) {
    var gif = gifImage(width, height);
    for (var y = 0; y < height; y += 1) {
      for (var x = 0; x < width; x += 1) {
        gif.setPixel(x, y, getPixel(x, y) );
      }
    }

    var b = byteArrayOutputStream();
    gif.write(b);

    var base64 = base64EncodeOutputStream();
    var bytes = b.toByteArray();
    for (var i = 0; i < bytes.length; i += 1) {
      base64.writeByte(bytes[i]);
    }
    base64.flush();

    return 'data:image/gif;base64,' + base64;
  };

  //---------------------------------------------------------------------
  // returns qrcode function.

  return qrcode;
}();

// multibyte support
!function() {

  qrcode.stringToBytesFuncs['UTF-8'] = function(s) {
    // http://stackoverflow.com/questions/18729405/how-to-convert-utf8-string-to-byte-array
    function toUTF8Array(str) {
      var utf8 = [];
      for (var i=0; i < str.length; i++) {
        var charcode = str.charCodeAt(i);
        if (charcode < 0x80) utf8.push(charcode);
        else if (charcode < 0x800) {
          utf8.push(0xc0 | (charcode >> 6),
              0x80 | (charcode & 0x3f));
        }
        else if (charcode < 0xd800 || charcode >= 0xe000) {
          utf8.push(0xe0 | (charcode >> 12),
              0x80 | ((charcode>>6) & 0x3f),
              0x80 | (charcode & 0x3f));
        }
        // surrogate pair
        else {
          i++;
          // UTF-16 encodes 0x10000-0x10FFFF by
          // subtracting 0x10000 and splitting the
          // 20 bits of 0x0-0xFFFFF into two halves
          charcode = 0x10000 + (((charcode & 0x3ff)<<10)
            | (str.charCodeAt(i) & 0x3ff));
          utf8.push(0xf0 | (charcode >>18),
              0x80 | ((charcode>>12) & 0x3f),
              0x80 | ((charcode>>6) & 0x3f),
              0x80 | (charcode & 0x3f));
        }
      }
      return utf8;
    }
    return toUTF8Array(s);
  };

}();


    return qrcode;
  })();

  /* ------------------------------------------------------------------ SHA-256 (sync, tiny) */
  var K256 = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
  function sha256(msg) {
    var l = msg.length, nb = ((l + 9 + 63) >> 6) << 6, m = new Uint8Array(nb), i, j;
    m.set(msg); m[l] = 0x80;
    var bits = l * 8; m[nb - 4] = (bits >>> 24) & 255; m[nb - 3] = (bits >>> 16) & 255; m[nb - 2] = (bits >>> 8) & 255; m[nb - 1] = bits & 255;
    var H = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19], w = new Array(64);
    function r(x, n) { return (x >>> n) | (x << (32 - n)); }
    for (i = 0; i < nb; i += 64) {
      for (j = 0; j < 16; j++) w[j] = (m[i + 4 * j] << 24) | (m[i + 4 * j + 1] << 16) | (m[i + 4 * j + 2] << 8) | m[i + 4 * j + 3];
      for (j = 16; j < 64; j++) {
        var s0 = r(w[j - 15], 7) ^ r(w[j - 15], 18) ^ (w[j - 15] >>> 3), s1 = r(w[j - 2], 17) ^ r(w[j - 2], 19) ^ (w[j - 2] >>> 10);
        w[j] = (w[j - 16] + s0 + w[j - 7] + s1) | 0;
      }
      var a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
      for (j = 0; j < 64; j++) {
        var t1 = (h + (r(e, 6) ^ r(e, 11) ^ r(e, 25)) + ((e & f) ^ (~e & g)) + K256[j] + w[j]) | 0;
        var t2 = ((r(a, 2) ^ r(a, 13) ^ r(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
        h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
      H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
    }
    var out = new Uint8Array(32);
    for (i = 0; i < 8; i++) { out[4 * i] = H[i] >>> 24; out[4 * i + 1] = (H[i] >>> 16) & 255; out[4 * i + 2] = (H[i] >>> 8) & 255; out[4 * i + 3] = H[i] & 255; }
    return out;
  }

  /* ------------------------------------------------------------------ address + amount validation */
  var B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  function b58decode(s) {
    var bytes = [0], i, j, carry;
    for (i = 0; i < s.length; i++) {
      var v = B58.indexOf(s[i]); if (v < 0) return null;
      carry = v;
      for (j = 0; j < bytes.length; j++) { carry += bytes[j] * 58; bytes[j] = carry & 255; carry >>= 8; }
      while (carry) { bytes.push(carry & 255); carry >>= 8; }
    }
    for (i = 0; i < s.length && s[i] === '1'; i++) bytes.push(0);
    return new Uint8Array(bytes.reverse());
  }
  function toHex(u8) { var s = ''; for (var i = 0; i < u8.length; i++) s += (u8[i] < 16 ? '0' : '') + u8[i].toString(16); return s; }
  /** Classify a BSV address. Only mainnet P2PKH (version 0x00, "1…") is accepted.
   *  Returns {script} on success, or {error: 'eTo'|'eToNet'|'eToType'}. */
  function inspectAddress(addr) {
    if (typeof addr !== 'string' || !addr) return { error: 'eTo' };
    // Bech32 / CashAddr / URI prefixes are never a mainnet P2PKH address.
    if (/^(bc1|tb1|bcrt1|bitcoincash:|bchtest:|bsvreg:)/i.test(addr) || /^[qp][a-z0-9]{40,}$/i.test(addr)) return { error: 'eTo' };
    if (!/^[123mn][1-9A-HJ-NP-Za-km-z]{24,34}$/.test(addr)) return { error: 'eTo' };
    var raw = b58decode(addr);
    if (!raw || raw.length !== 25) return { error: 'eTo' };
    var chk = sha256(sha256(raw.subarray(0, 21)));
    for (var i = 0; i < 4; i++) if (chk[i] !== raw[21 + i]) return { error: 'eTo' };
    if (raw[0] === 0) return { script: '76a914' + toHex(raw.subarray(1, 21)) + '88ac' };
    // 0x6f = testnet/STN P2PKH (m…/n…), 0xc4 = testnet/STN P2SH (2…)
    if (raw[0] === 0x6f || raw[0] === 0xc4) return { error: 'eToNet' };
    // 0x05 = mainnet P2SH (3…) — valid checksum, but this button only pays to P2PKH
    if (raw[0] === 0x05) return { error: 'eToType' };
    return { error: 'eTo' };
  }
  /** Mainnet P2PKH (base58check, version 0x00). Returns the expected locking script hex or null. */
  function addressScript(addr) {
    var i = inspectAddress(addr);
    return i && i.script ? i.script : null;
  }
  function addressError(addr) {
    var i = inspectAddress(addr);
    return i && i.script ? null : (i && i.error) || 'eTo';
  }
  /** Parse a BSV amount to satoshis. Integer part up to 16 digits so values above 21000000 BSV
   *  fail as "too large" rather than as a format error. Returns null on a bad format (caller uses amountError). */
  function amountParts(s) {
    var m = /^(\d{1,16})(?:\.(\d{1,8}))?$/.exec(String(s == null ? '' : s).trim());
    if (!m) return null;
    var whole = m[1].replace(/^0+/, '') || '0';
    if (whole.length > 8) return Infinity;   // > 99_999_999 BSV, well above the 21000000 cap
    return Number(whole) * 1e8 + Number(((m[2] || '') + '00000000').slice(0, 8));
  }
  /** "0.0005" -> 50000 sats. Strict decimal parsing (max 8 decimals), no floats involved. */
  function parseAmount(s) {
    var sats = amountParts(s);
    return sats != null && sats >= 1 && sats <= MAX_SATS ? sats : null;
  }
  /** Distinguish format errors from out-of-range amounts (1 sat … 21000000 BSV). */
  function amountError(s) {
    var t = String(s == null ? '' : s).trim();
    if (!t) return 'eAmount';
    var sats = amountParts(t);
    if (sats == null) return 'eAmount';
    if (sats < 1) return 'eAmountMin';
    if (sats > MAX_SATS) return 'eAmountMax';
    return null;
  }
  /** data-confirm-above: BSV amount, 0 allowed (= always wait for 1 confirmation). null = invalid */
  function parseThreshold(s) {
    var t = String(s == null ? '' : s).trim();
    if (/^0+(\.0+)?$/.test(t)) return 0;
    return parseAmount(t);
  }
  function fmtBsv(sats) {
    var s = String(sats); while (s.length < 9) s = '0' + s;
    var frac = s.slice(-8).replace(/0+$/, '');
    return s.slice(0, -8) + (frac ? '.' + frac : '');
  }
  /** sats with thousands separator: ',' in English, a narrow no-break space elsewhere (a ',' would read as a decimal
   *  comma in de/es/fr/it/pt). BSV amounts themselves are never localised (always a dot, like in wallets). */
  function fmtSats(n, lang) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, lang && lang !== 'en' ? '\u202f' : ','); }
  function short(s, a, b) { s = String(s); return s.length > a + b + 1 ? s.slice(0, a) + '\u2026' + s.slice(-b) : s; }
  function clean(s, max) { return String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max); }
  /** e-mail check for data-shipping-email and the buyer's optional e-mail. Deliberately strict: no spaces, quotes,
   *  brackets or URL characters (? & # %), so a value can never add extra mailto: parameters or break out of a header. */
  var EMAIL_RE = /^[A-Za-z0-9._+\-!$*=^`{|}~']{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?)+$/;
  function isEmail(v) { return typeof v === 'string' && v.length <= 120 && EMAIL_RE.test(v); }
  /** data-shipping-url: https:// only (http://localhost / 127.0.0.1 for local development), no user:password@.
   *  Returns the host to show the buyer, or null if the URL is not acceptable. */
  function shipUrlHost(v) {
    if (typeof v !== 'string' || !/^https:\/\/[^\s"'<>\\]+$|^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/[^\s"'<>\\]*$/.test(v)) return null;
    try { var u = new URL(v); return u.username || u.password ? null : u.host; } catch (e) { return null; }
  }
  function rnd(n) { var a = new Uint32Array(1); (window.crypto || window.msCrypto).getRandomValues(a); return a[0] % n; }
  /** random order reference when the shop sets none: "kp-" + 80 random bits (CSPRNG) as hex */
  function genRef() { var a = new Uint8Array(10); (window.crypto || window.msCrypto).getRandomValues(a); return 'kp-' + toHex(a); }
  /** data-order-id: 1-64 chars, letters/digits . _ - : / # (no spaces, quotes, <, >, &). null = invalid */
  function parseOrderId(v) { var t = String(v == null ? '' : v).trim(); return ORDER_RE.test(t) ? t : null; }
  /** "25" / "25.5" / "25.00" -> integer cents. Strict: dot decimal, max 2 decimals, 0.01 ... 1,000,000.00. null = invalid */
  function parseFiat(v) {
    var m = /^(\d{1,7})(?:\.(\d{1,2}))?$/.exec(String(v == null ? '' : v).trim());
    if (!m) return null;
    var c = Number(m[1]) * 100 + Number(((m[2] || '') + '00').slice(0, 2));
    return c >= 1 && c <= MAX_FIAT_CENTS ? c : null;
  }
  /** fiat rate (fiat per 1 BSV, a JSON number) -> integer micro units, or null if not usable */
  function rateMicro(r) {
    var n = typeof r === 'number' ? r : typeof r === 'string' && /^\d{1,8}(\.\d{1,12})?$/.test(r) ? Number(r) : NaN;
    if (!isFinite(n) || n <= 0 || n > RATE_MAX) return null;
    var u = Math.round(n * 1e6);
    return u >= 1 ? u : null;
  }
  /** cents + rate (micro units) -> satoshis, rounded UP to the next whole satoshi so the shop never receives less than the price.
   *  sats = ceil(cents * 10^4 * 10^8 / rateMicro), computed with BigInt (exact). null if out of range or BigInt is missing. */
  function fiatToSats(cents, rMicro) {
    if (typeof BigInt !== 'function' || !(cents >= 1) || !(rMicro >= 1) || cents % 1 || rMicro % 1) return null;
    var num = BigInt(cents) * BigInt(1000000000000), den = BigInt(rMicro);
    var q = num / den; if (num % den !== BigInt(0)) q = q + BigInt(1);
    if (q > BigInt(MAX_SATS) || q < BigInt(1)) return null;
    return Number(q);
  }
  /** validates a rate answer; returns {rate, micro, ts, source} or null (stale, future, zero, garbage) */
  function checkRate(v, ts, source, nowS) {
    var micro = rateMicro(v), t = Number(ts), now = nowS == null ? Math.floor(Date.now() / 1000) : nowS;
    if (micro == null || !isFinite(t) || t <= 0 || t % 1) return null;
    if (now - t > RATE_MAX_AGE_S || t - now > RATE_FUTURE_S) return null;
    return { rate: micro / 1e6, micro: micro, ts: t, source: source };
  }
  /** one CSV line -> fields (handles "quoted, fields") */
  function csvRow(l) {
    var out = [], cur = '', q = false, i, ch;
    for (i = 0; i < l.length; i++) {
      ch = l.charAt(i);
      if (q) { if (ch === '"') { if (l.charAt(i + 1) === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
      else if (ch === '"') q = true; else if (ch === ',') { out.push(cur); cur = ''; } else cur += ch;
    }
    out.push(cur); return out;
  }
  /** ECB EUR/USD reference rate: plausible (0.5-2.0 USD per EUR), date not in the future and at most 5 calendar days old. */
  function checkEcb(v, date, nowMs) {
    if (typeof v !== 'string' || typeof date !== 'string' || !/^\d\.\d{1,6}$/.test(v) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
    var n = Number(v), d = Date.parse(date + 'T00:00:00Z'), now = nowMs == null ? Date.now() : nowMs, today = Math.floor(now / 86400000) * 86400000;
    if (!(n >= ECB_MIN && n <= ECB_MAX) || !isFinite(d) || d > today || today - d > ECB_MAX_AGE_D * 86400000) return null;
    return { usdPerEur: n, date: date, raw: v };
  }
  /** ECB Data Portal CSV -> {usdPerEur, date} or null. Needs the USD/EUR series columns TIME_PERIOD + OBS_VALUE. */
  function parseEcbCsv(txt, nowMs) {
    if (typeof txt !== 'string' || txt.length > 20000) return null;
    var lines = txt.replace(/\r/g, '').split('\n').filter(function (l) { return l.trim() !== ''; });
    if (lines.length !== 2) return null;
    var head = csvRow(lines[0]), row = csvRow(lines[1]);
    var col = function (k) { var i = head.indexOf(k); return i < 0 || row.length !== head.length ? null : row[i]; };
    if (col('CURRENCY') !== 'USD' || col('CURRENCY_DENOM') !== 'EUR') return null;
    return checkEcb(col('OBS_VALUE'), col('TIME_PERIOD'), nowMs);
  }
  var ecbCache = null;   // {v: {usdPerEur, date}, at: ms}
  function fetchEcb() {
    if (ecbCache && Date.now() - ecbCache.at < ECB_CACHE_MS && checkEcb(ecbCache.v.raw, ecbCache.v.date)) return Promise.resolve(ecbCache.v);
    return getText(RATE_ECB).then(function (txt) {
      var v = parseEcbCsv(txt); if (!v) throw new Error('ecb');
      ecbCache = { v: v, at: Date.now() }; return v;
    });
  }
  function wocUsd() {
    return getJson(RATE_WOC).then(function (j) {
      var r = j && j.currency === 'USD' ? checkRate(j.rate, j.time, 'whatsonchain') : null;
      if (!r) throw new Error('rate');
      return r;
    });
  }
  /** current rate for EUR or USD. CoinGecko first. Backup (unless data-fallback="0"): USD = WhatsOnChain, EUR = WhatsOnChain USD
   *  divided by the ECB EUR/USD reference rate. Rejects (no quote, no QR) if nothing fresh is available. */
  function fetchRate(cur, backup) {
    var cg = getJson(RATE_CG).then(function (j) {
      var o = j && j['bitcoin-cash-sv'], r = o ? checkRate(o[cur.toLowerCase()], o.last_updated_at, 'coingecko') : null;
      if (!r) throw new Error('rate');
      return r;
    });
    if (backup === false) return cg;
    return cg.then(null, function () {
      if (cur === 'USD') return wocUsd();
      return Promise.all([wocUsd(), fetchEcb()]).then(function (a) {
        var r = checkRate(a[0].rate / a[1].usdPerEur, a[0].ts, 'whatsonchain+ecb');
        if (!r) throw new Error('rate');
        r.usdRate = a[0].rate; r.ecbRate = a[1].usdPerEur; r.ecbDate = a[1].date;
        return r;
      });
    });
  }
  function srcName(q) {
    return q.source === 'coingecko' ? 'CoinGecko' : q.source === 'whatsonchain' ? 'WhatsOnChain'
      : 'WhatsOnChain (USD) \u00d7 ECB EUR/USD ' + q.ecbRate + ' (' + q.ecbDate + ')';
  }
  function intlLocale(lang) { return { en: 'en-US', de: 'de-DE', es: 'es-ES', fr: 'fr-FR', it: 'it-IT', pt: 'pt-BR' }[lang] || 'en-US'; }
  function fmtFiat(cents, cur, lang) {
    try { return new Intl.NumberFormat(intlLocale(lang), { style: 'currency', currency: cur, minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(cents / 100); }
    catch (e) { return (cents / 100).toFixed(2) + ' ' + cur; }
  }
  function fmtRate(rate, cur, lang) {
    try { return new Intl.NumberFormat(intlLocale(lang), { style: 'currency', currency: cur, minimumFractionDigits: 2, maximumFractionDigits: rate < 1 ? 6 : 4 }).format(rate); }
    catch (e) { return String(rate) + ' ' + cur; }
  }
  function fmtTime(ts, lang) {
    var d = new Date(ts * 1000);
    try { return d.toLocaleTimeString(intlLocale(lang), { hour: '2-digit', minute: '2-digit' }); } catch (e) { return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2); }
  }

  /* ------------------------------------------------------------------ raw tx verification (no trust in any API's JSON) */
  function hexBytes(h) {
    if (typeof h !== 'string' || !h.length || h.length % 2 || h.length > MAX_TX_HEX || !/^[0-9a-fA-F]+$/.test(h)) return null;
    var b = new Uint8Array(h.length / 2);
    for (var i = 0; i < b.length; i++) b[i] = parseInt(h.substr(2 * i, 2), 16);
    return b;
  }
  function txidOf(bytes) { var d = sha256(sha256(bytes)), r = new Uint8Array(32); for (var i = 0; i < 32; i++) r[i] = d[31 - i]; return toHex(r); }
  /** Full raw-tx parse: version, inputs (prevTxid/vout/script/sequence), outputs, locktime, size. Throws if malformed. */
  function parseTx(b) {
    var o = 0;
    function need(n) { if (!(n >= 0) || o + n > b.length) throw new Error('truncated'); }
    function u32() { need(4); var v = (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) + b[o + 3] * 16777216; o += 4; return v; }
    function vi() {
      need(1); var x = b[o++];
      if (x < 0xfd) return x;
      if (x === 0xfd) { need(2); var v = b[o] | (b[o + 1] << 8); o += 2; return v; }
      if (x === 0xfe) return u32();
      var lo = u32(), hi = u32(); if (hi) throw new Error('varint'); return lo;
    }
    function bytes(n) { need(n); var s = b.subarray(o, o + n); o += n; return s; }
    function revHex(u8) { var r = new Uint8Array(u8.length), i; for (i = 0; i < u8.length; i++) r[i] = u8[u8.length - 1 - i]; return toHex(r); }
    var version = u32();
    var nIn = vi(); if (nIn < 1 || nIn > (b.length - o) / 41) throw new Error('inputs');
    var inputs = [];
    for (var i = 0; i < nIn; i++) {
      need(36); var prev = bytes(32), vout = u32(), sl = vi(), script = bytes(sl), sequence = u32();
      inputs.push({ prevTxid: revHex(prev), prev: prev, vout: vout, script: script, sequence: sequence });
    }
    var nOut = vi(); if (nOut < 1 || nOut > (b.length - o) / 9) throw new Error('outputs');
    var outs = [];
    for (var n = 0; n < nOut; n++) {
      var lo = u32(), hi = u32(), value = hi * 4294967296 + lo;
      if (value > MAX_SATS) throw new Error('value');
      var l = vi(); outs.push({ value: value, script: bytes(l) });
    }
    var locktime = u32();
    if (o !== b.length) throw new Error('trailing bytes');
    return { version: version, inputs: inputs, outputs: outs, locktime: locktime, size: b.length };
  }
  /** outputs [{value (integer sats), script (Uint8Array)}] of a serialized tx; throws on anything malformed */
  function txOutputs(b) { return parseTx(b).outputs; }
  /** A transaction is final when every input has nSequence = 0xffffffff (nLockTime is then ignored), or nLockTime is 0.
   *  If a non-final sequence is combined with a height/time lock that has not passed, the tx is not final. */
  function isTxFinal(tx, nowS, tipHeight) {
    if (!tx || !tx.inputs || !tx.inputs.length) return false;
    var i, allFinal = true;
    for (i = 0; i < tx.inputs.length; i++) if (tx.inputs[i].sequence !== FINAL_SEQUENCE) allFinal = false;
    if (allFinal || tx.locktime === 0) return true;
    if (tx.locktime < 500000000) return tipHeight != null && tipHeight >= tx.locktime;
    return nowS != null && nowS >= tx.locktime;
  }
  /** Finality of a verified raw tx. Most wallets set every nSequence to 0xffffffff (final, no lookup). For a height lock the
   *  chain tip is read (own node, then fallback); without a tip the tx counts as not final (safe side).
   *  Resolves { final: bool, tip: height|null }. */
  function finality(o, hex) {
    var b = hexBytes(hex), tx; if (!b) return Promise.resolve({ final: false, tip: null });
    try { tx = parseTx(b); } catch (e) { return Promise.resolve({ final: false, tip: null }); }
    var nowS = Math.floor(Date.now() / 1000);
    if (isTxFinal(tx, nowS, null)) return Promise.resolve({ final: true, tip: null });
    if (tx.locktime >= 500000000) return Promise.resolve({ final: false, tip: null });
    var srcs = []; if (o.node) srcs.push(o.node + '/chain/info'); if (o.fallback) srcs.push(o.fallback + '/chain/info');
    return srcs.reduce(function (p, url) {
      return p.then(function (tip) {
        if (tip != null) return tip;
        return getJson(url).then(function (j) { var n = Math.floor(Number(j && j.blocks)); return n > 0 ? n : null; }, function () { return null; });
      });
    }, Promise.resolve(null)).then(function (tip) { return { final: tip != null && isTxFinal(tx, nowS, tip), tip: tip }; });
  }
  /** fee * 1000 >= satPerKb * size, integer (no floats). */
  function feeSufficient(feeSats, size, satPerKb) {
    if (typeof BigInt !== 'function' || !(feeSats >= 0) || feeSats % 1 || !(size >= 1) || size % 1 || !(satPerKb >= 1) || satPerKb % 1) return false;
    return BigInt(feeSats) * BigInt(1000) >= BigInt(satPerKb) * BigInt(size);
  }
  /** EUR cents * USD-per-EUR, rounded DOWN so the 0-conf line is never above the EUR amount. */
  function eurToUsdCents(eurCents, usdPerEur) {
    var micro = rateMicro(usdPerEur);
    if (typeof BigInt !== 'function' || micro == null || !(eurCents >= 0) || eurCents % 1) return null;
    return Number(BigInt(eurCents) * BigInt(micro) / BigInt(1000000));
  }
  /** EUR cents / (EUR per 1 BSV) -> sats, rounded DOWN (the 0-conf line is never above the EUR amount). */
  function eurToSatsFloor(cents, rMicro) {
    if (typeof BigInt !== 'function' || !(cents >= 1) || !(rMicro >= 1) || cents % 1 || rMicro % 1) return null;
    var q = BigInt(cents) * BigInt(1000000000000) / BigInt(rMicro);
    if (q > BigInt(MAX_SATS) || q < BigInt(0)) return null;
    return Number(q);
  }
  function varintBytes(n) {
    if (n < 0xfd) return new Uint8Array([n]);
    if (n <= 0xffff) return new Uint8Array([0xfd, n & 255, (n >>> 8) & 255]);
    var a = new Uint8Array(5); a[0] = 0xfe; a[1] = n & 255; a[2] = (n >>> 8) & 255; a[3] = (n >>> 16) & 255; a[4] = (n / 16777216) & 255; return a;
  }
  function u64bytes(n) {
    var lo = n % 4294967296, hi = Math.floor(n / 4294967296), a = new Uint8Array(8);
    a[0] = lo & 255; a[1] = (lo >>> 8) & 255; a[2] = (lo >>> 16) & 255; a[3] = (lo / 16777216) & 255;
    a[4] = hi & 255; a[5] = (hi >>> 8) & 255; a[6] = (hi >>> 16) & 255; a[7] = (hi / 16777216) & 255;
    return a;
  }
  function catBytes(parts) {
    var n = 0, i, o = 0, out; for (i = 0; i < parts.length; i++) n += parts[i].length;
    out = new Uint8Array(n); for (i = 0; i < parts.length; i++) { out.set(parts[i], o); o += parts[i].length; }
    return out;
  }
  /** BIP-239 Extended Format (EF) from a raw tx + prevouts [{value, script}]. Used so BSV Broadcaster can check the fee
   *  without a UTXO lookup. Marker 0000000000EF after version; prevout value + locking script after each input sequence. */
  function toEf(hex, prevouts) {
    var b = hexBytes(hex), tx, i, parts, inp, prev, ver, rest;
    if (!b) return null;
    try { tx = parseTx(b); } catch (e) { return null; }
    if (!prevouts || prevouts.length !== tx.inputs.length) return null;
    ver = b.subarray(0, 4);
    parts = [ver, new Uint8Array([0, 0, 0, 0, 0, 0xef]), varintBytes(tx.inputs.length)];
    for (i = 0; i < tx.inputs.length; i++) {
      inp = tx.inputs[i]; prev = prevouts[i];
      if (!prev || !(prev.value >= 0) || !prev.script) return null;
      parts.push(inp.prev, new Uint8Array([inp.vout & 255, (inp.vout >>> 8) & 255, (inp.vout >>> 16) & 255, (inp.vout / 16777216) & 255]),
        varintBytes(inp.script.length), inp.script,
        new Uint8Array([inp.sequence & 255, (inp.sequence >>> 8) & 255, (inp.sequence >>> 16) & 255, (inp.sequence / 16777216) & 255]),
        u64bytes(prev.value), varintBytes(prev.script.length), prev.script);
    }
    // outputs + locktime: everything after the inputs in the original raw tx
    // reconstruct from parsed fields to avoid offset arithmetic bugs
    parts.push(varintBytes(tx.outputs.length));
    for (i = 0; i < tx.outputs.length; i++) {
      parts.push(u64bytes(tx.outputs[i].value), varintBytes(tx.outputs[i].script.length), tx.outputs[i].script);
    }
    parts.push(new Uint8Array([tx.locktime & 255, (tx.locktime >>> 8) & 255, (tx.locktime >>> 16) & 255, (tx.locktime / 16777216) & 255]));
    return toHex(catBytes(parts));
  }
  /**
   * 0-conf limits for an invoice. The shop threshold is always an EUR amount (data-confirm-above-fiat, default 200.00).
   * USD: converted with the ECB USD/EUR rate, floored. BSV: converted with the EUR/BSV rate, floored.
   * Without a valid rate the caller must wait for 1 confirmation. An explicit data-confirm-above (BSV) overrides this
   * and needs no rate. fallback is the 20.00 EUR line used when the quick check is unavailable.
   */
  function zeroConfLimits(c, inv) {
    var eur = c.confirmAboveFiat, fx = (inv && (inv.fx || inv.quote)) || {}, out;
    var usdPerEur = fx.usdPerEur != null ? fx.usdPerEur : fx.ecbRate;
    var eurMicro = fx.eurMicro != null ? fx.eurMicro : (fx.cur === 'EUR' ? fx.micro : null);
    out = { alwaysWait: false, rateOk: true, unit: 'cents', high: eur, fallback: FALLBACK_ZERO_CONF_CENTS,
      confirmAboveEur: eur, applied: eur, appliedFallback: FALLBACK_ZERO_CONF_CENTS, explicitBsv: false };
    if (!c.fiat && c.confirmAbove != null) {
      out.unit = 'sats'; out.high = c.confirmAbove; out.fallback = c.confirmAbove; out.applied = c.confirmAbove;
      out.explicitBsv = true; out.alwaysWait = c.confirmAbove === 0; return out;
    }
    if (eur === 0) { out.alwaysWait = true; out.high = 0; out.fallback = 0; out.applied = 0; out.appliedFallback = 0; return out; }
    if (c.fiat && c.fiat.cur === 'EUR') return out;
    if (c.fiat && c.fiat.cur === 'USD') {
      var hi = eurToUsdCents(eur, usdPerEur), fb = eurToUsdCents(FALLBACK_ZERO_CONF_CENTS, usdPerEur);
      if (hi == null || fb == null) { out.rateOk = false; out.alwaysWait = true; return out; }
      out.high = hi; out.fallback = fb; out.applied = hi; out.appliedFallback = fb; return out;
    }
    var hs = eurToSatsFloor(eur, eurMicro), fs = eurToSatsFloor(FALLBACK_ZERO_CONF_CENTS, eurMicro);
    if (hs == null || fs == null) { out.rateOk = false; out.alwaysWait = true; out.unit = 'sats'; return out; }
    out.unit = 'sats'; out.high = hs; out.fallback = fs; out.applied = hs; out.appliedFallback = fs; return out;
  }
  /** true = this amount cannot be accepted at 0-conf, even with a passed quick check (above the line / no rate / always wait). */
  function needsBlockConf(c, inv) {
    var lim = zeroConfLimits(c, inv);
    if (!lim.rateOk || lim.alwaysWait) return true;
    if (lim.unit === 'cents') return c.fiat.cents > lim.high;
    if (lim.explicitBsv) return inv.sats >= lim.high;
    return inv.sats > lim.high;
  }
  /** true = amount is within the 20 EUR (or explicit BSV) fallback, so 0-conf is still allowed if the quick check is unavailable. */
  function withinFallback(c, inv) {
    var lim = zeroConfLimits(c, inv);
    if (!lim.rateOk || lim.alwaysWait) return false;
    if (lim.unit === 'cents') return c.fiat.cents <= lim.fallback;
    if (lim.explicitBsv) return inv.sats < lim.high;
    return inv.sats <= lim.fallback;
  }
  function attachFx(inv, r, ecb) {
    if (!inv) return;
    inv.fx = inv.fx || {};
    if (r) {
      if (r.cur) inv.fx.cur = r.cur;
      if (r.micro != null) inv.fx.micro = r.micro;
      if (r.rate != null) inv.fx.rate = r.rate;
      if (r.source) inv.fx.source = r.source;
      if (r.ts != null) inv.fx.ts = r.ts;
      if (r.cur === 'EUR' && r.micro != null) { inv.fx.eurMicro = r.micro; inv.fx.eurRate = r.rate; }
      if (r.usdRate != null) inv.fx.usdRate = r.usdRate;
      if (r.ecbRate != null) { inv.fx.usdPerEur = r.ecbRate; inv.fx.ecbDate = r.ecbDate; }
    }
    if (ecb && ecb.usdPerEur != null) { inv.fx.usdPerEur = ecb.usdPerEur; inv.fx.ecbDate = ecb.date; }
    if (inv.quote && ecb && inv.quote.ecbRate == null) { inv.quote.ecbRate = ecb.usdPerEur; inv.quote.ecbDate = ecb.date; }
  }
  var QUICK_GOOD = { SEEN_ON_NETWORK: 1, MINED: 1, IMMUTABLE: 1 };
  var QUICK_BAD = { DOUBLE_SPEND_ATTEMPTED: 1, REJECTED: 1, INVALID: 1, MALFORMED: 1, MINED_IN_STALE_BLOCK: 1 };
  function statusResult(j) {
    if (!j || j.__404 || j.error) return { missing: true };
    var st = String(j.txStatus || ''), competing = Array.isArray(j.competingTxs) && j.competingTxs.length > 0;
    if (competing || QUICK_BAD[st] || /ORPHAN/i.test(st + (j.extraInfo || ''))) {
      return { bad: true, txStatus: st, competing: competing, competingTxs: j.competingTxs, extraInfo: j.extraInfo };
    }
    return { txStatus: st, ok: !!QUICK_GOOD[st], competing: false, extraInfo: j.extraInfo };
  }
  /** satoshis a raw tx (hex) pays to scriptHex; null if the hex is not exactly the tx `txid` or is malformed */
  function verifiedSats(hex, txid, scriptHex) {
    var b = hexBytes(hex); if (!b || txidOf(b) !== txid) return null;
    var outs; try { outs = txOutputs(b); } catch (e) { return null; }
    var want = scriptHex.length / 2, sats = 0;
    for (var i = 0; i < outs.length; i++) if (outs[i].script.length === want && toHex(outs[i].script) === scriptHex) sats += outs[i].value;
    return sats > MAX_SATS ? null : sats;
  }

  /* ------------------------------------------------------------------ i18n
   *  Language: data-lang="de" (or "auto") > nearest lang="…" attribute of the page (normally <html lang>) > English.
   *  The shop decides the language, not the visitor's browser (navigator.language is deliberately not used).
   *  Amounts are never localised: BSV always uses a dot as decimal separator, like in wallets. */
  var I18N = {
    en: {
      payWith: 'Pay with BSV', payAmount: 'Pay {a} BSV', paidBtn: 'Paid \u2713', seenBtn: 'Payment seen \u2013 confirming\u2026',
      poweredBy: 'Powered by', titleM: 'Pay {m}', title: 'Pay with BSV', order: 'Order #{o}', close: 'Close',
      foot: '\uD83D\uDD12 Non-custodial \u00b7 paid straight to merchant', qr: 'Payment QR code',
      testNote: 'Test mode \u00b7 demo only, do not send real BSV', amount: 'Amount',
      tag: 'Please send exactly this amount (incl. +{n} sats payment ID)',
      copy: 'Copy', copied: 'Copied', copyFail: 'Select & copy', copyAria: 'Copy merchant address', addr: 'Merchant address',
      open: 'Open in wallet \u2197', timeLeft: 'Time left', waiting: 'Waiting for payment\u2026', auto: 'Detected automatically',
      testSoon: 'Test mode \u00b7 simulated in a few seconds', testSim: 'Test mode \u00b7 simulated', confs: '{n} conf',
      confirmed: 'Confirmed \u00b7 {c}', seenNet: 'Seen on network', testNoTx: 'Test mode: no real transaction',
      explorer: 'View in Kallubi Explorer \u2197', back: 'Back to shop', received: 'Payment received',
      thanksM: 'Thank you! Paid straight to {m}.', thanks: 'Thank you! Paid straight to the merchant.',
      paidTo: 'Paid to', tx: 'Transaction', status: 'Status', sinceSeen: 'Time since the payment was seen',
      seenWait: 'Payment seen \u2013 waiting for 1 confirmation (~10 min)', testConf: 'Test mode \u00b7 confirmation simulated',
      safe: 'Your payment is safe. Keep this page open, it updates by itself.', seenH: 'Payment seen',
      confInfo: 'Amounts from {a} BSV wait for one block confirmation.', seenPill: 'Seen \u00b7 0 / 1 conf',
      confInfoFiat: 'Prices above {a} wait for one block confirmation.',
      confInfoRate: 'Waiting for 1 confirmation because no valid exchange rate is available.',
      checkH: 'Checking the payment', checkWait: 'Checking the payment on the network\u2026',
      checkInfo: 'The button checks that the payment was seen on your node and at the miner service, is final, pays a sufficient fee, and is not spent twice. This takes a few seconds.',
      checkPill: 'Checking \u00b7 a few seconds',
      dropH: 'Payment not confirmed', dropP: 'The network did not keep this transaction (it was replaced or became invalid), so the shop has not received it. Please check your wallet before you pay again.',
      again: 'Try again', expH: 'Payment window expired',
      expP: 'No payment was detected in time. If you already paid, please do not pay again \u2013 contact the shop with your transaction ID.',
      eTo: 'invalid BSV address in data-to (mainnet P2PKH "1\u2026" address expected)',
      eToNet: 'data-to is a testnet or STN address; a mainnet P2PKH address ("1\u2026") is required',
      eToType: 'data-to is a P2SH address ("3\u2026"); only mainnet P2PKH ("1\u2026") is supported',
      eAmount: 'invalid amount in data-amount (BSV, e.g. "0.0005", max 8 decimals)',
      eAmountMin: 'data-amount must be at least 1 satoshi (0.00000001 BSV)',
      eAmountMax: 'data-amount must not exceed 21000000 BSV',
      eCur: 'data-currency "{c}" is not supported in v1 (BSV only)',
      eConf: 'invalid data-confirm-above (BSV amount, e.g. "0.01"; 0 = always wait for 1 confirmation)',
      eConfBoth: 'data-confirm-above (BSV) cannot be combined with data-amount-fiat or data-confirm-above-fiat: use data-confirm-above-fiat (EUR amount)',
      eConfFiat: 'invalid data-confirm-above-fiat (amount in EUR, e.g. "200"; 0 = always wait for 1 confirmation)',
      eConfFiatBsv: 'data-confirm-above-fiat only works with data-amount-fiat (BSV prices use data-confirm-above)',
      eApi: 'data-api must be an https:// URL',
      /* v1.0.0 shipping address (data-shipping) */
      shipH: 'Shipping address', shipSub: 'Where should your order go?', fName: 'Full name', fStreet: 'Street and number', fZip: 'Postal code', fCity: 'City',
      fCountry: 'Country', fEmail: 'Email (optional)', fNote: 'Note for the shop (optional)', req: 'Required', badEmail: 'Please enter a valid email address',
      fixErr: 'Please check the marked fields.', shipNoteM: '\uD83D\uDD12 Your address goes only to {m}, never to Kallubi.', shipNote: '\uD83D\uDD12 Your address goes only to the shop, never to Kallubi.',
      shipVia: 'Sent directly to {h}.', toPay: 'Continue to payment', shipTo: 'Ship to', edit: 'Edit', shipSending: 'Sending your address to the shop\u2026', shipSent: 'Address sent to the shop \u2713',
      shipFail: 'Your address could not be sent automatically.', shipMail: 'Email address to the shop \u2709', shipMailHint: 'Opens your email app with address and transaction ID filled in. Just press send.',
      shipKeep: 'Please contact the shop with your address and transaction ID.', mailSubj: 'Order {o}: shipping address', mailHello: 'Hello, here is my shipping address for my BSV payment:',
      eShipUrl: 'data-shipping-url must be an https:// URL', eShipMail: 'invalid email address in data-shipping-email',
      /* v1.2.0 */
      payFiat: 'Pay {a}', fiatPrice: 'Price: {f}', rateLine: '1 BSV = {r} \u00b7 rate from {t}', rateFixed: 'This amount is fixed until the timer runs out.',
      rateSrc: 'Rate source: {s}',
      quoting: 'Getting the current exchange rate\u2026', rateH: 'Exchange rate unavailable', rateP: 'No current exchange rate could be loaded, so no payment is requested right now. Please try again in a moment.',
      lateH: 'Payment arrived too late', lateP: 'Your payment was detected after the payment window had ended. Please do not pay again \u2013 contact the shop with your transaction ID so it can check the payment.', latePill: 'After the deadline',
      eFiat: 'invalid amount in data-amount-fiat (e.g. "25.00", max 2 decimals, 0.01 to 1000000.00)', eFiatCur: 'data-currency "{c}" is not supported with data-amount-fiat (EUR or USD)',
      eBoth: 'use either data-amount (BSV) or data-amount-fiat, not both', eCurFiat: 'for EUR or USD prices use data-amount-fiat',
      eOrder: 'invalid data-order-id (1 to 64 characters: letters, digits and . _ - : / #)', eExp: 'invalid data-expires-min (whole minutes, 1 to 60)'
    },
    de: {
      payWith: 'Mit BSV bezahlen', payAmount: '{a} BSV bezahlen', paidBtn: 'Bezahlt \u2713', seenBtn: 'Zahlung erkannt \u2013 wird best\u00e4tigt\u2026',
      poweredBy: 'Bereitgestellt von', titleM: 'Bei {m} bezahlen', title: 'Mit BSV bezahlen', order: 'Bestellung #{o}', close: 'Schlie\u00dfen',
      foot: '\uD83D\uDD12 Ohne Verwahrung \u00b7 direkt an den H\u00e4ndler', qr: 'QR-Code zur Zahlung',
      testNote: 'Testmodus \u00b7 nur Demo, kein echtes BSV senden', amount: 'Betrag',
      tag: 'Bitte genau diesen Betrag senden (inkl. +{n} sats Zahlungskennung)',
      copy: 'Kopieren', copied: 'Kopiert', copyFail: 'Markieren & kopieren', copyAria: 'H\u00e4ndleradresse kopieren', addr: 'H\u00e4ndleradresse',
      open: 'In Wallet \u00f6ffnen \u2197', timeLeft: 'Verbleibende Zeit', waiting: 'Warte auf Zahlung\u2026', auto: 'Wird automatisch erkannt',
      testSoon: 'Testmodus \u00b7 wird in wenigen Sekunden simuliert', testSim: 'Testmodus \u00b7 simuliert', confs: '{n} Best\u00e4t.',
      confirmed: 'Best\u00e4tigt \u00b7 {c}', seenNet: 'Im Netzwerk erkannt', testNoTx: 'Testmodus: keine echte Transaktion',
      explorer: 'Im Kallubi Explorer ansehen \u2197', back: 'Zur\u00fcck zum Shop', received: 'Zahlung erhalten',
      thanksM: 'Danke! Direkt an {m} bezahlt.', thanks: 'Danke! Direkt an den H\u00e4ndler bezahlt.',
      paidTo: 'Bezahlt an', tx: 'Transaktion', status: 'Status', sinceSeen: 'Zeit seit Erkennung der Zahlung',
      seenWait: 'Zahlung erkannt \u2013 warte auf 1 Best\u00e4tigung (~10 Min.)', testConf: 'Testmodus \u00b7 Best\u00e4tigung simuliert',
      safe: 'Deine Zahlung ist sicher. Lass die Seite offen, sie aktualisiert sich selbst.', seenH: 'Zahlung erkannt',
      confInfo: 'Betr\u00e4ge ab {a} BSV warten auf eine Blockbest\u00e4tigung.', seenPill: 'Erkannt \u00b7 0 / 1 Best\u00e4t.',
      confInfoFiat: 'Preise \u00fcber {a} warten auf eine Blockbest\u00e4tigung.',
      confInfoRate: 'Es wird auf 1 Best\u00e4tigung gewartet, weil kein g\u00fcltiger Wechselkurs vorliegt.',
      checkH: 'Zahlung wird gepr\u00fcft', checkWait: 'Die Zahlung wird im Netz gepr\u00fcft\u2026',
      checkInfo: 'Der Knopf pr\u00fcft, dass die Zahlung auf deiner Node und beim Miner-Dienst gesehen wurde, endg\u00fcltig ist, genug Geb\u00fchr zahlt und nicht doppelt ausgegeben wird. Das dauert wenige Sekunden.',
      checkPill: 'Pr\u00fcfung \u00b7 wenige Sekunden',
      dropH: 'Zahlung nicht best\u00e4tigt', dropP: 'Das Netzwerk hat diese Transaktion nicht behalten (sie wurde ersetzt oder ist ung\u00fcltig geworden), der Shop hat sie also nicht erhalten. Bitte pr\u00fcfe deine Wallet, bevor du erneut zahlst.',
      again: 'Erneut versuchen', expH: 'Zahlungszeit abgelaufen',
      expP: 'Es wurde keine Zahlung rechtzeitig erkannt. Falls du schon bezahlt hast, bitte nicht noch einmal zahlen \u2013 melde dich mit deiner Transaktions-ID beim Shop.',
      eTo: 'ung\u00fcltige BSV-Adresse in data-to (Mainnet-P2PKH-Adresse \u201e1\u2026\u201c erwartet)',
      eToNet: 'data-to ist eine Testnet- oder STN-Adresse; eine Mainnet-P2PKH-Adresse (\u201e1\u2026\u201c) ist erforderlich',
      eToType: 'data-to ist eine P2SH-Adresse (\u201e3\u2026\u201c); nur Mainnet-P2PKH (\u201e1\u2026\u201c) wird unterst\u00fctzt',
      eAmount: 'ung\u00fcltiger Betrag in data-amount (BSV, z. B. \u201e0.0005\u201c, max. 8 Nachkommastellen)',
      eAmountMin: 'data-amount muss mindestens 1 Satoshi betragen (0.00000001 BSV)',
      eAmountMax: 'data-amount darf 21000000 BSV nicht \u00fcberschreiten',
      eCur: 'data-currency \u201e{c}\u201c wird in v1 nicht unterst\u00fctzt (nur BSV)',
      eConf: 'ung\u00fcltiges data-confirm-above (BSV-Betrag, z. B. \u201e0.01\u201c; 0 = immer auf 1 Best\u00e4tigung warten)',
      eConfBoth: 'data-confirm-above (BSV) geht nicht zusammen mit data-amount-fiat oder data-confirm-above-fiat: bitte data-confirm-above-fiat verwenden (Euro-Betrag)',
      eConfFiat: 'ung\u00fcltiges data-confirm-above-fiat (Betrag in Euro, z. B. \u201e200\u201c; 0 = immer auf 1 Best\u00e4tigung warten)',
      eConfFiatBsv: 'data-confirm-above-fiat wirkt nur mit data-amount-fiat (BSV-Preise nutzen data-confirm-above)',
      eApi: 'data-api muss eine https://-URL sein',
      /* v1.0.0 shipping address (data-shipping) */
      shipH: 'Lieferadresse', shipSub: 'Wohin soll deine Bestellung gehen?', fName: 'Vor- und Nachname', fStreet: 'Stra\u00dfe und Hausnummer', fZip: 'PLZ', fCity: 'Ort',
      fCountry: 'Land', fEmail: 'E-Mail (optional)', fNote: 'Nachricht an den Shop (optional)', req: 'Pflichtfeld', badEmail: 'Bitte gib eine g\u00fcltige E-Mail-Adresse ein',
      fixErr: 'Bitte pr\u00fcfe die markierten Felder.', shipNoteM: '\uD83D\uDD12 Deine Adresse geht nur an {m}, nie an Kallubi.', shipNote: '\uD83D\uDD12 Deine Adresse geht nur an den Shop, nie an Kallubi.',
      shipVia: 'Wird direkt an {h} gesendet.', toPay: 'Weiter zur Zahlung', shipTo: 'Lieferung an', edit: '\u00c4ndern', shipSending: 'Adresse wird an den Shop gesendet\u2026',
      shipSent: 'Adresse an den Shop gesendet \u2713', shipFail: 'Deine Adresse konnte nicht automatisch gesendet werden.', shipMail: 'Adresse per E-Mail an den Shop \u2709',
      shipMailHint: '\u00d6ffnet dein E-Mail-Programm mit Adresse und Transaktions-ID. Nur noch auf Senden dr\u00fccken.', shipKeep: 'Bitte schick dem Shop deine Adresse und die Transaktions-ID.',
      mailSubj: 'Bestellung {o}: Lieferadresse', mailHello: 'Hallo, hier ist meine Lieferadresse zu meiner BSV-Zahlung:', eShipUrl: 'data-shipping-url muss eine https://-URL sein',
      eShipMail: 'ung\u00fcltige E-Mail-Adresse in data-shipping-email',
      /* v1.2.0 */
      payFiat: '{a} bezahlen', fiatPrice: 'Preis: {f}', rateLine: '1 BSV = {r} \u00b7 Kurs von {t}', rateFixed: 'Dieser Betrag gilt, bis der Timer abgelaufen ist.',
      rateSrc: 'Kursquelle: {s}',
      quoting: 'Aktueller Wechselkurs wird geladen\u2026', rateH: 'Kein Wechselkurs verf\u00fcgbar', rateP: 'Es konnte kein aktueller Wechselkurs geladen werden, deshalb wird gerade keine Zahlung angefordert. Bitte versuche es gleich noch einmal.',
      lateH: 'Zahlung kam zu sp\u00e4t', lateP: 'Deine Zahlung wurde erst nach Ablauf des Zahlungsfensters erkannt. Bitte nicht noch einmal zahlen \u2013 melde dich mit deiner Transaktions-ID beim Shop, damit er die Zahlung pr\u00fcfen kann.', latePill: 'Nach Ablauf',
      eFiat: 'ung\u00fcltiger Betrag in data-amount-fiat (z. B. "25.00", max. 2 Nachkommastellen, 0.01 bis 1000000.00)', eFiatCur: 'data-currency "{c}" wird mit data-amount-fiat nicht unterst\u00fctzt (EUR oder USD)',
      eBoth: 'entweder data-amount (BSV) oder data-amount-fiat verwenden, nicht beides', eCurFiat: 'f\u00fcr Preise in EUR oder USD data-amount-fiat verwenden',
      eOrder: 'ung\u00fcltige data-order-id (1 bis 64 Zeichen: Buchstaben, Ziffern und . _ - : / #)', eExp: 'ung\u00fcltiges data-expires-min (ganze Minuten, 1 bis 60)'
    },
    es: {
      payWith: 'Pagar con BSV', payAmount: 'Pagar {a} BSV', paidBtn: 'Pagado \u2713', seenBtn: 'Pago detectado \u2013 confirmando\u2026',
      poweredBy: 'Con tecnolog\u00eda de', titleM: 'Pagar a {m}', title: 'Pagar con BSV', order: 'Pedido #{o}', close: 'Cerrar',
      foot: '\uD83D\uDD12 Sin custodia \u00b7 pago directo al comercio', qr: 'C\u00f3digo QR de pago',
      testNote: 'Modo de prueba \u00b7 solo demo, no env\u00edes BSV real', amount: 'Importe',
      tag: 'Env\u00eda exactamente este importe (incl. +{n} sats de ID de pago)',
      copy: 'Copiar', copied: 'Copiado', copyFail: 'Selecciona y copia', copyAria: 'Copiar direcci\u00f3n del comercio', addr: 'Direcci\u00f3n del comercio',
      open: 'Abrir en la wallet \u2197', timeLeft: 'Tiempo restante', waiting: 'Esperando el pago\u2026', auto: 'Se detecta autom\u00e1ticamente',
      testSoon: 'Modo de prueba \u00b7 simulado en unos segundos', testSim: 'Modo de prueba \u00b7 simulado', confs: '{n} conf.',
      confirmed: 'Confirmado \u00b7 {c}', seenNet: 'Visto en la red', testNoTx: 'Modo de prueba: sin transacci\u00f3n real',
      explorer: 'Ver en Kallubi Explorer \u2197', back: 'Volver a la tienda', received: 'Pago recibido',
      thanksM: '\u00a1Gracias! Pagado directamente a {m}.', thanks: '\u00a1Gracias! Pagado directamente al comercio.',
      paidTo: 'Pagado a', tx: 'Transacci\u00f3n', status: 'Estado', sinceSeen: 'Tiempo desde que se detect\u00f3 el pago',
      seenWait: 'Pago detectado \u2013 esperando 1 confirmaci\u00f3n (~10 min)', testConf: 'Modo de prueba \u00b7 confirmaci\u00f3n simulada',
      safe: 'Tu pago est\u00e1 seguro. Mant\u00e9n esta p\u00e1gina abierta, se actualiza sola.', seenH: 'Pago detectado',
      confInfo: 'Los importes desde {a} BSV esperan una confirmaci\u00f3n de bloque.', seenPill: 'Detectado \u00b7 0 / 1 conf.',
      confInfoFiat: 'Los precios superiores a {a} esperan una confirmaci\u00f3n de bloque.',
      confInfoRate: 'Se espera 1 confirmaci\u00f3n porque no hay un tipo de cambio v\u00e1lido.',
      checkH: 'Comprobando el pago', checkWait: 'Comprobando el pago en la red\u2026',
      checkInfo: 'El bot\u00f3n comprueba que el pago se vio en tu nodo y en el servicio del minero, es definitivo, paga una comisi\u00f3n suficiente y no se gasta dos veces. Tarda unos segundos.',
      checkPill: 'Comprobando \u00b7 unos segundos',
      dropH: 'Pago no confirmado', dropP: 'La red no conserv\u00f3 esta transacci\u00f3n (fue reemplazada o dej\u00f3 de ser v\u00e1lida), as\u00ed que la tienda no la ha recibido. Revisa tu monedero antes de volver a pagar.',
      again: 'Intentar de nuevo', expH: 'El plazo de pago ha expirado',
      expP: 'No se detect\u00f3 ning\u00fan pago a tiempo. Si ya pagaste, no vuelvas a pagar: contacta con la tienda indicando tu ID de transacci\u00f3n.',
      eTo: 'direcci\u00f3n BSV no v\u00e1lida en data-to (se espera una direcci\u00f3n P2PKH de mainnet "1\u2026")',
      eToNet: 'data-to es una direcci\u00f3n de testnet o STN; se requiere una direcci\u00f3n P2PKH de mainnet ("1\u2026")',
      eToType: 'data-to es una direcci\u00f3n P2SH ("3\u2026"); solo se admite P2PKH de mainnet ("1\u2026")',
      eAmount: 'importe no v\u00e1lido en data-amount (BSV, p. ej. "0.0005", m\u00e1x. 8 decimales)',
      eAmountMin: 'data-amount debe ser al menos 1 satoshi (0.00000001 BSV)',
      eAmountMax: 'data-amount no debe superar 21000000 BSV',
      eCur: 'data-currency "{c}" no es compatible en v1 (solo BSV)',
      eConf: 'data-confirm-above no v\u00e1lido (importe en BSV, p. ej. "0.01"; 0 = esperar siempre 1 confirmaci\u00f3n)',
      eConfBoth: 'data-confirm-above (BSV) no se puede combinar con data-amount-fiat o data-confirm-above-fiat: use data-confirm-above-fiat (importe en EUR)',
      eConfFiat: 'data-confirm-above-fiat no v\u00e1lido (importe en EUR, p. ej. "200"; 0 = esperar siempre 1 confirmaci\u00f3n)',
      eConfFiatBsv: 'data-confirm-above-fiat solo funciona con data-amount-fiat (los precios en BSV usan data-confirm-above)',
      eApi: 'data-api debe ser una URL https://',
      /* v1.0.0 shipping address (data-shipping) */
      shipH: 'Direcci\u00f3n de env\u00edo', shipSub: '\u00bfA d\u00f3nde enviamos tu pedido?', fName: 'Nombre completo', fStreet: 'Calle y n\u00famero', fZip: 'C\u00f3digo postal',
      fCity: 'Ciudad', fCountry: 'Pa\u00eds', fEmail: 'Correo electr\u00f3nico (opcional)', fNote: 'Nota para la tienda (opcional)', req: 'Obligatorio', badEmail: 'Introduce un correo electr\u00f3nico v\u00e1lido',
      fixErr: 'Revisa los campos marcados.', shipNoteM: '\uD83D\uDD12 Tu direcci\u00f3n solo se env\u00eda a {m}, nunca a Kallubi.', shipNote: '\uD83D\uDD12 Tu direcci\u00f3n solo se env\u00eda a la tienda, nunca a Kallubi.',
      shipVia: 'Se env\u00eda directamente a {h}.', toPay: 'Continuar al pago', shipTo: 'Enviar a', edit: 'Editar', shipSending: 'Enviando tu direcci\u00f3n a la tienda\u2026',
      shipSent: 'Direcci\u00f3n enviada a la tienda \u2713', shipFail: 'No se pudo enviar tu direcci\u00f3n autom\u00e1ticamente.', shipMail: 'Enviar direcci\u00f3n por correo \u2709',
      shipMailHint: 'Abre tu app de correo con la direcci\u00f3n y el ID de transacci\u00f3n ya escritos. Solo tienes que enviarlo.', shipKeep: 'Contacta con la tienda indicando tu direcci\u00f3n y el ID de transacci\u00f3n.',
      mailSubj: 'Pedido {o}: direcci\u00f3n de env\u00edo', mailHello: 'Hola, esta es mi direcci\u00f3n de env\u00edo para mi pago en BSV:', eShipUrl: 'data-shipping-url debe ser una URL https://',
      eShipMail: 'correo electr\u00f3nico no v\u00e1lido en data-shipping-email',
      /* v1.2.0 */
      payFiat: 'Pagar {a}', fiatPrice: 'Precio: {f}', rateLine: '1 BSV = {r} \u00b7 cambio de las {t}', rateFixed: 'Este importe es v\u00e1lido hasta que termine el temporizador.',
      rateSrc: 'Fuente del cambio: {s}',
      quoting: 'Obteniendo el tipo de cambio actual\u2026', rateH: 'Tipo de cambio no disponible', rateP: 'No se pudo cargar un tipo de cambio actual, por eso ahora no se solicita ning\u00fan pago. Int\u00e9ntalo de nuevo en un momento.',
      lateH: 'El pago lleg\u00f3 tarde', lateP: 'Tu pago se detect\u00f3 despu\u00e9s de que terminara el plazo de pago. No vuelvas a pagar: contacta con la tienda indicando tu ID de transacci\u00f3n para que revise el pago.', latePill: 'Fuera de plazo',
      eFiat: 'importe no v\u00e1lido en data-amount-fiat (p. ej. "25.00", m\u00e1x. 2 decimales, 0.01 a 1000000.00)', eFiatCur: 'data-currency "{c}" no es compatible con data-amount-fiat (EUR o USD)',
      eBoth: 'usa data-amount (BSV) o data-amount-fiat, no ambos', eCurFiat: 'para precios en EUR o USD usa data-amount-fiat',
      eOrder: 'data-order-id no v\u00e1lido (1 a 64 caracteres: letras, d\u00edgitos y . _ - : / #)', eExp: 'data-expires-min no v\u00e1lido (minutos enteros, 1 a 60)'
    },
    fr: {
      payWith: 'Payer avec BSV', payAmount: 'Payer {a} BSV', paidBtn: 'Pay\u00e9 \u2713', seenBtn: 'Paiement d\u00e9tect\u00e9 \u2013 confirmation\u2026',
      poweredBy: 'Propuls\u00e9 par', titleM: 'Payer {m}', title: 'Payer avec BSV', order: 'Commande #{o}', close: 'Fermer',
      foot: '\uD83D\uDD12 Non d\u00e9positaire \u00b7 pay\u00e9 directement au marchand', qr: 'QR code de paiement',
      testNote: 'Mode test \u00b7 d\u00e9mo, n\u2019envoyez pas de vrais BSV', amount: 'Montant',
      tag: 'Envoyez exactement ce montant (dont +{n} sats d\u2019identifiant de paiement)',
      copy: 'Copier', copied: 'Copi\u00e9', copyFail: 'S\u00e9lectionnez et copiez', copyAria: 'Copier l\u2019adresse du marchand', addr: 'Adresse du marchand',
      open: 'Ouvrir dans le portefeuille \u2197', timeLeft: 'Temps restant', waiting: 'En attente du paiement\u2026', auto: 'D\u00e9tect\u00e9 automatiquement',
      testSoon: 'Mode test \u00b7 simul\u00e9 dans quelques secondes', testSim: 'Mode test \u00b7 simul\u00e9', confs: '{n} conf.',
      confirmed: 'Confirm\u00e9 \u00b7 {c}', seenNet: 'Vu sur le r\u00e9seau', testNoTx: 'Mode test\u00a0: aucune transaction r\u00e9elle',
      explorer: 'Voir dans Kallubi Explorer \u2197', back: 'Retour \u00e0 la boutique', received: 'Paiement re\u00e7u',
      thanksM: 'Merci\u00a0! Pay\u00e9 directement \u00e0 {m}.', thanks: 'Merci\u00a0! Pay\u00e9 directement au marchand.',
      paidTo: 'Pay\u00e9 \u00e0', tx: 'Transaction', status: 'Statut', sinceSeen: 'Temps \u00e9coul\u00e9 depuis la d\u00e9tection du paiement',
      seenWait: 'Paiement d\u00e9tect\u00e9 \u2013 en attente d\u20191 confirmation (~10 min)', testConf: 'Mode test \u00b7 confirmation simul\u00e9e',
      safe: 'Votre paiement est s\u00e9curis\u00e9. Gardez cette page ouverte, elle se met \u00e0 jour toute seule.', seenH: 'Paiement d\u00e9tect\u00e9',
      confInfo: '\u00c0 partir de {a} BSV, une confirmation de bloc est attendue.', seenPill: 'D\u00e9tect\u00e9 \u00b7 0 / 1 conf.',
      confInfoFiat: 'Au-del\u00e0 de {a}, une confirmation de bloc est attendue.',
      confInfoRate: 'En attente d\u20191 confirmation car aucun taux de change valable n\u2019est disponible.',
      checkH: 'V\u00e9rification du paiement', checkWait: 'V\u00e9rification du paiement sur le r\u00e9seau\u2026',
      checkInfo: 'Le bouton v\u00e9rifie que le paiement a \u00e9t\u00e9 vu sur votre n\u0153ud et chez le service du mineur, qu\u2019il est d\u00e9finitif, qu\u2019il paie des frais suffisants et qu\u2019il n\u2019est pas d\u00e9pens\u00e9 deux fois. Cela prend quelques secondes.',
      checkPill: 'V\u00e9rification \u00b7 quelques secondes',
      dropH: 'Paiement non confirm\u00e9', dropP: 'Le r\u00e9seau n\u2019a pas conserv\u00e9 cette transaction (remplac\u00e9e ou devenue invalide), la boutique ne l\u2019a donc pas re\u00e7ue. V\u00e9rifiez votre portefeuille avant de payer \u00e0 nouveau.',
      again: 'R\u00e9essayer', expH: 'D\u00e9lai de paiement expir\u00e9',
      expP: 'Aucun paiement n\u2019a \u00e9t\u00e9 d\u00e9tect\u00e9 \u00e0 temps. Si vous avez d\u00e9j\u00e0 pay\u00e9, ne payez pas une seconde fois \u2013 contactez la boutique avec votre ID de transaction.',
      eTo: 'adresse BSV invalide dans data-to (adresse P2PKH mainnet \u00ab\u00a01\u2026\u00a0\u00bb attendue)',
      eToNet: 'data-to est une adresse testnet ou STN\u00a0; une adresse P2PKH mainnet (\u00ab\u00a01\u2026\u00a0\u00bb) est requise',
      eToType: 'data-to est une adresse P2SH (\u00ab\u00a03\u2026\u00a0\u00bb)\u00a0; seule la P2PKH mainnet (\u00ab\u00a01\u2026\u00a0\u00bb) est prise en charge',
      eAmount: 'montant invalide dans data-amount (BSV, ex. \u00ab\u00a00.0005\u00a0\u00bb, 8 d\u00e9cimales max.)',
      eAmountMin: 'data-amount doit \u00eatre d\u2019au moins 1 satoshi (0.00000001 BSV)',
      eAmountMax: 'data-amount ne doit pas d\u00e9passer 21000000 BSV',
      eCur: 'data-currency \u00ab\u00a0{c}\u00a0\u00bb n\u2019est pas pris en charge en v1 (BSV uniquement)',
      eConf: 'data-confirm-above invalide (montant BSV, ex. \u00ab\u00a00.01\u00a0\u00bb\u00a0; 0 = toujours attendre 1 confirmation)',
      eConfBoth: 'data-confirm-above (BSV) ne peut pas \u00eatre combin\u00e9 avec data-amount-fiat ou data-confirm-above-fiat\u00a0: utilisez data-confirm-above-fiat (montant en EUR)',
      eConfFiat: 'data-confirm-above-fiat invalide (montant en EUR, ex. \u00ab\u00a0200\u00a0\u00bb\u00a0; 0 = toujours attendre 1 confirmation)',
      eConfFiatBsv: 'data-confirm-above-fiat ne fonctionne qu\u2019avec data-amount-fiat (les prix en BSV utilisent data-confirm-above)',
      eApi: 'data-api doit \u00eatre une URL https://',
      /* v1.0.0 shipping address (data-shipping) */
      shipH: 'Adresse de livraison', shipSub: 'O\u00f9 devons-nous envoyer votre commande\u00a0?', fName: 'Nom complet', fStreet: 'Rue et num\u00e9ro', fZip: 'Code postal',
      fCity: 'Ville', fCountry: 'Pays', fEmail: 'E-mail (facultatif)', fNote: 'Message pour la boutique (facultatif)', req: 'Obligatoire', badEmail: 'Veuillez saisir une adresse e-mail valide',
      fixErr: 'Veuillez v\u00e9rifier les champs marqu\u00e9s.', shipNoteM: '\uD83D\uDD12 Votre adresse est envoy\u00e9e uniquement \u00e0 {m}, jamais \u00e0 Kallubi.',
      shipNote: '\uD83D\uDD12 Votre adresse est envoy\u00e9e uniquement \u00e0 la boutique, jamais \u00e0 Kallubi.', shipVia: 'Envoy\u00e9e directement \u00e0 {h}.',
      toPay: 'Continuer vers le paiement', shipTo: 'Livrer \u00e0', edit: 'Modifier', shipSending: 'Envoi de votre adresse \u00e0 la boutique\u2026', shipSent: 'Adresse envoy\u00e9e \u00e0 la boutique \u2713',
      shipFail: 'Votre adresse n\u2019a pas pu \u00eatre envoy\u00e9e automatiquement.', shipMail: 'Envoyer l\u2019adresse par e-mail \u2709', shipMailHint: 'Ouvre votre messagerie avec l\u2019adresse et l\u2019ID de transaction d\u00e9j\u00e0 remplis. Il suffit d\u2019envoyer.',
      shipKeep: 'Veuillez contacter la boutique avec votre adresse et votre ID de transaction.', mailSubj: 'Commande {o}\u00a0: adresse de livraison', mailHello: 'Bonjour, voici mon adresse de livraison pour mon paiement en BSV\u00a0:',
      eShipUrl: 'data-shipping-url doit \u00eatre une URL https://', eShipMail: 'adresse e-mail invalide dans data-shipping-email',
      /* v1.2.0 */
      payFiat: 'Payer {a}', fiatPrice: 'Prix : {f}', rateLine: '1 BSV = {r} \u00b7 cours de {t}', rateFixed: 'Ce montant est valable jusqu\u2019\u00e0 la fin du minuteur.',
      rateSrc: 'Source du cours\u00a0: {s}',
      quoting: 'R\u00e9cup\u00e9ration du cours actuel\u2026', rateH: 'Cours indisponible', rateP: 'Aucun cours actuel n\u2019a pu \u00eatre charg\u00e9, aucun paiement n\u2019est donc demand\u00e9 pour le moment. R\u00e9essayez dans un instant.',
      lateH: 'Paiement arriv\u00e9 trop tard', lateP: 'Votre paiement a \u00e9t\u00e9 d\u00e9tect\u00e9 apr\u00e8s la fin du d\u00e9lai de paiement. Ne payez pas une seconde fois \u2013 contactez la boutique avec votre ID de transaction pour qu\u2019elle v\u00e9rifie le paiement.', latePill: 'Hors d\u00e9lai',
      eFiat: 'montant invalide dans data-amount-fiat (ex. "25.00", 2 d\u00e9cimales max., 0.01 \u00e0 1000000.00)', eFiatCur: 'data-currency "{c}" n\u2019est pas pris en charge avec data-amount-fiat (EUR ou USD)',
      eBoth: 'utilisez data-amount (BSV) ou data-amount-fiat, pas les deux', eCurFiat: 'pour des prix en EUR ou USD, utilisez data-amount-fiat',
      eOrder: 'data-order-id invalide (1 \u00e0 64 caract\u00e8res : lettres, chiffres et . _ - : / #)', eExp: 'data-expires-min invalide (minutes enti\u00e8res, 1 \u00e0 60)'
    },
    it: {
      payWith: 'Paga con BSV', payAmount: 'Paga {a} BSV', paidBtn: 'Pagato \u2713', seenBtn: 'Pagamento rilevato \u2013 conferma in corso\u2026',
      poweredBy: 'Realizzato con', titleM: 'Paga {m}', title: 'Paga con BSV', order: 'Ordine #{o}', close: 'Chiudi',
      foot: '\uD83D\uDD12 Senza custodia \u00b7 pagato direttamente al venditore', qr: 'Codice QR di pagamento',
      testNote: 'Modalit\u00e0 test \u00b7 demo, non inviare BSV reali', amount: 'Importo',
      tag: 'Invia esattamente questo importo (incl. +{n} sats di ID pagamento)',
      copy: 'Copia', copied: 'Copiato', copyFail: 'Seleziona e copia', copyAria: 'Copia l\u2019indirizzo del venditore', addr: 'Indirizzo del venditore',
      open: 'Apri nel wallet \u2197', timeLeft: 'Tempo rimanente', waiting: 'In attesa del pagamento\u2026', auto: 'Rilevato automaticamente',
      testSoon: 'Modalit\u00e0 test \u00b7 simulato tra pochi secondi', testSim: 'Modalit\u00e0 test \u00b7 simulato', confs: '{n} conf.',
      confirmed: 'Confermato \u00b7 {c}', seenNet: 'Visto in rete', testNoTx: 'Modalit\u00e0 test: nessuna transazione reale',
      explorer: 'Vedi su Kallubi Explorer \u2197', back: 'Torna al negozio', received: 'Pagamento ricevuto',
      thanksM: 'Grazie! Pagato direttamente a {m}.', thanks: 'Grazie! Pagato direttamente al venditore.',
      paidTo: 'Pagato a', tx: 'Transazione', status: 'Stato', sinceSeen: 'Tempo trascorso dal rilevamento del pagamento',
      seenWait: 'Pagamento rilevato \u2013 in attesa di 1 conferma (~10 min)', testConf: 'Modalit\u00e0 test \u00b7 conferma simulata',
      safe: 'Il tuo pagamento \u00e8 al sicuro. Tieni aperta questa pagina, si aggiorna da sola.', seenH: 'Pagamento rilevato',
      confInfo: 'Gli importi da {a} BSV attendono una conferma di blocco.', seenPill: 'Rilevato \u00b7 0 / 1 conf.',
      confInfoFiat: 'I prezzi oltre {a} attendono una conferma di blocco.',
      confInfoRate: 'In attesa di 1 conferma perch\u00e9 non \u00e8 disponibile un tasso di cambio valido.',
      checkH: 'Verifica del pagamento', checkWait: 'Verifica del pagamento sulla rete\u2026',
      checkInfo: 'Il pulsante verifica che il pagamento sia stato visto sul tuo nodo e nel servizio del miner, che sia definitivo, che paghi una commissione sufficiente e che non sia speso due volte. Ci vogliono pochi secondi.',
      checkPill: 'Verifica \u00b7 pochi secondi',
      dropH: 'Pagamento non confermato', dropP: 'La rete non ha mantenuto questa transazione (\u00e8 stata sostituita o non \u00e8 pi\u00f9 valida), quindi il negozio non l\u2019ha ricevuta. Controlla il tuo wallet prima di pagare di nuovo.',
      again: 'Riprova', expH: 'Tempo per il pagamento scaduto',
      expP: 'Nessun pagamento rilevato in tempo. Se hai gi\u00e0 pagato, non pagare di nuovo \u2013 contatta il negozio con il tuo ID transazione.',
      eTo: 'indirizzo BSV non valido in data-to (atteso un indirizzo P2PKH mainnet "1\u2026")',
      eToNet: 'data-to \u00e8 un indirizzo testnet o STN; \u00e8 richiesto un indirizzo P2PKH mainnet ("1\u2026")',
      eToType: 'data-to \u00e8 un indirizzo P2SH ("3\u2026"); \u00e8 supportato solo P2PKH mainnet ("1\u2026")',
      eAmount: 'importo non valido in data-amount (BSV, es. "0.0005", max 8 decimali)',
      eAmountMin: 'data-amount deve essere di almeno 1 satoshi (0.00000001 BSV)',
      eAmountMax: 'data-amount non deve superare 21000000 BSV',
      eCur: 'data-currency "{c}" non \u00e8 supportata nella v1 (solo BSV)',
      eConf: 'data-confirm-above non valido (importo BSV, es. "0.01"; 0 = attendi sempre 1 conferma)',
      eConfBoth: 'data-confirm-above (BSV) non si pu\u00f2 combinare con data-amount-fiat o data-confirm-above-fiat: usa data-confirm-above-fiat (importo in EUR)',
      eConfFiat: 'data-confirm-above-fiat non valido (importo in EUR, es. "200"; 0 = attendi sempre 1 conferma)',
      eConfFiatBsv: 'data-confirm-above-fiat funziona solo con data-amount-fiat (i prezzi in BSV usano data-confirm-above)',
      eApi: 'data-api deve essere un URL https://',
      /* v1.0.0 shipping address (data-shipping) */
      shipH: 'Indirizzo di spedizione', shipSub: 'Dove spediamo il tuo ordine?', fName: 'Nome e cognome', fStreet: 'Via e numero civico', fZip: 'CAP', fCity: 'Citt\u00e0',
      fCountry: 'Paese', fEmail: 'E-mail (facoltativa)', fNote: 'Nota per il negozio (facoltativa)', req: 'Obbligatorio', badEmail: 'Inserisci un indirizzo e-mail valido',
      fixErr: 'Controlla i campi evidenziati.', shipNoteM: '\uD83D\uDD12 Il tuo indirizzo va solo a {m}, mai a Kallubi.', shipNote: '\uD83D\uDD12 Il tuo indirizzo va solo al negozio, mai a Kallubi.',
      shipVia: 'Inviato direttamente a {h}.', toPay: 'Continua al pagamento', shipTo: 'Spedire a', edit: 'Modifica', shipSending: 'Invio dell\u2019indirizzo al negozio\u2026',
      shipSent: 'Indirizzo inviato al negozio \u2713', shipFail: 'Non \u00e8 stato possibile inviare l\u2019indirizzo automaticamente.', shipMail: 'Invia l\u2019indirizzo via e-mail \u2709',
      shipMailHint: 'Apre la tua app di posta con indirizzo e ID transazione gi\u00e0 compilati. Basta premere invia.', shipKeep: 'Contatta il negozio con il tuo indirizzo e l\u2019ID transazione.',
      mailSubj: 'Ordine {o}: indirizzo di spedizione', mailHello: 'Ciao, ecco il mio indirizzo di spedizione per il pagamento in BSV:', eShipUrl: 'data-shipping-url deve essere un URL https://',
      eShipMail: 'indirizzo e-mail non valido in data-shipping-email',
      /* v1.2.0 */
      payFiat: 'Paga {a}', fiatPrice: 'Prezzo: {f}', rateLine: '1 BSV = {r} \u00b7 cambio delle {t}', rateFixed: 'Questo importo vale fino allo scadere del timer.',
      rateSrc: 'Fonte del cambio: {s}',
      quoting: 'Recupero del cambio attuale\u2026', rateH: 'Cambio non disponibile', rateP: 'Non \u00e8 stato possibile caricare un cambio attuale, quindi al momento non viene richiesto alcun pagamento. Riprova tra poco.',
      lateH: 'Pagamento arrivato in ritardo', lateP: 'Il tuo pagamento \u00e8 stato rilevato dopo la scadenza della finestra di pagamento. Non pagare di nuovo \u2013 contatta il negozio con il tuo ID transazione, cos\u00ec potr\u00e0 verificare il pagamento.', latePill: 'Oltre la scadenza',
      eFiat: 'importo non valido in data-amount-fiat (es. "25.00", max 2 decimali, da 0.01 a 1000000.00)', eFiatCur: 'data-currency "{c}" non \u00e8 supportata con data-amount-fiat (EUR o USD)',
      eBoth: 'usa data-amount (BSV) oppure data-amount-fiat, non entrambi', eCurFiat: 'per prezzi in EUR o USD usa data-amount-fiat',
      eOrder: 'data-order-id non valido (da 1 a 64 caratteri: lettere, cifre e . _ - : / #)', eExp: 'data-expires-min non valido (minuti interi, da 1 a 60)'
    },
    pt: {
      payWith: 'Pagar com BSV', payAmount: 'Pagar {a} BSV', paidBtn: 'Pago \u2713', seenBtn: 'Pagamento detectado \u2013 confirmando\u2026',
      poweredBy: 'Com tecnologia', titleM: 'Pagar a {m}', title: 'Pagar com BSV', order: 'Pedido #{o}', close: 'Fechar',
      foot: '\uD83D\uDD12 Sem cust\u00f3dia \u00b7 pago direto ao lojista', qr: 'C\u00f3digo QR de pagamento',
      testNote: 'Modo de teste \u00b7 demo, n\u00e3o envie BSV real', amount: 'Valor',
      tag: 'Envie exatamente este valor (incl. +{n} sats de ID do pagamento)',
      copy: 'Copiar', copied: 'Copiado', copyFail: 'Selecione e copie', copyAria: 'Copiar endere\u00e7o do lojista', addr: 'Endere\u00e7o do lojista',
      open: 'Abrir na carteira \u2197', timeLeft: 'Tempo restante', waiting: 'Aguardando pagamento\u2026', auto: 'Detectado automaticamente',
      testSoon: 'Modo de teste \u00b7 simulado em poucos segundos', testSim: 'Modo de teste \u00b7 simulado', confs: '{n} conf.',
      confirmed: 'Confirmado \u00b7 {c}', seenNet: 'Visto na rede', testNoTx: 'Modo de teste: nenhuma transa\u00e7\u00e3o real',
      explorer: 'Ver no Kallubi Explorer \u2197', back: 'Voltar \u00e0 loja', received: 'Pagamento recebido',
      thanksM: 'Obrigado! Pago direto a {m}.', thanks: 'Obrigado! Pago direto ao lojista.',
      paidTo: 'Pago a', tx: 'Transa\u00e7\u00e3o', status: 'Estado', sinceSeen: 'Tempo desde que o pagamento foi detectado',
      seenWait: 'Pagamento detectado \u2013 aguardando 1 confirma\u00e7\u00e3o (~10 min)', testConf: 'Modo de teste \u00b7 confirma\u00e7\u00e3o simulada',
      safe: 'Seu pagamento est\u00e1 seguro. Mantenha esta p\u00e1gina aberta, ela se atualiza sozinha.', seenH: 'Pagamento detectado',
      confInfo: 'Valores a partir de {a} BSV aguardam uma confirma\u00e7\u00e3o de bloco.', seenPill: 'Detectado \u00b7 0 / 1 conf.',
      confInfoFiat: 'Pre\u00e7os acima de {a} aguardam uma confirma\u00e7\u00e3o de bloco.',
      confInfoRate: 'A aguardar 1 confirma\u00e7\u00e3o porque n\u00e3o h\u00e1 uma taxa de c\u00e2mbio v\u00e1lida.',
      checkH: 'A verificar o pagamento', checkWait: 'A verificar o pagamento na rede\u2026',
      checkInfo: 'O bot\u00e3o verifica se o pagamento foi visto no teu n\u00f3 e no servi\u00e7o do minerador, se \u00e9 definitivo, se paga uma taxa suficiente e se n\u00e3o \u00e9 gasto duas vezes. Demora alguns segundos.',
      checkPill: 'A verificar \u00b7 alguns segundos',
      dropH: 'Pagamento n\u00e3o confirmado', dropP: 'A rede n\u00e3o manteve esta transa\u00e7\u00e3o (foi substitu\u00edda ou deixou de ser v\u00e1lida), portanto a loja n\u00e3o a recebeu. Verifique a sua carteira antes de pagar novamente.',
      again: 'Tentar novamente', expH: 'Prazo de pagamento expirado',
      expP: 'Nenhum pagamento foi detectado a tempo. Se voc\u00ea j\u00e1 pagou, n\u00e3o pague de novo \u2013 fale com a loja informando o ID da transa\u00e7\u00e3o.',
      eTo: 'endere\u00e7o BSV inv\u00e1lido em data-to (esperado um endere\u00e7o P2PKH da mainnet "1\u2026")',
      eToNet: 'data-to \u00e9 um endere\u00e7o de testnet ou STN; \u00e9 necess\u00e1rio um endere\u00e7o P2PKH da mainnet ("1\u2026")',
      eToType: 'data-to \u00e9 um endere\u00e7o P2SH ("3\u2026"); apenas P2PKH da mainnet ("1\u2026") \u00e9 suportado',
      eAmount: 'valor inv\u00e1lido em data-amount (BSV, ex. "0.0005", m\u00e1x. 8 casas decimais)',
      eAmountMin: 'data-amount deve ser de pelo menos 1 satoshi (0.00000001 BSV)',
      eAmountMax: 'data-amount n\u00e3o deve exceder 21000000 BSV',
      eCur: 'data-currency "{c}" n\u00e3o \u00e9 suportada na v1 (apenas BSV)',
      eConf: 'data-confirm-above inv\u00e1lido (valor em BSV, ex. "0.01"; 0 = sempre aguardar 1 confirma\u00e7\u00e3o)',
      eConfBoth: 'data-confirm-above (BSV) n\u00e3o pode ser combinado com data-amount-fiat ou data-confirm-above-fiat: use data-confirm-above-fiat (valor em EUR)',
      eConfFiat: 'data-confirm-above-fiat inv\u00e1lido (valor em EUR, ex. "200"; 0 = sempre aguardar 1 confirma\u00e7\u00e3o)',
      eConfFiatBsv: 'data-confirm-above-fiat s\u00f3 funciona com data-amount-fiat (pre\u00e7os em BSV usam data-confirm-above)',
      eApi: 'data-api deve ser uma URL https://',
      /* v1.0.0 shipping address (data-shipping) */
      shipH: 'Endere\u00e7o de entrega', shipSub: 'Para onde enviamos o seu pedido?', fName: 'Nome completo', fStreet: 'Rua e n\u00famero', fZip: 'C\u00f3digo postal',
      fCity: 'Cidade', fCountry: 'Pa\u00eds', fEmail: 'E-mail (opcional)', fNote: 'Nota para a loja (opcional)', req: 'Obrigat\u00f3rio', badEmail: 'Informe um e-mail v\u00e1lido',
      fixErr: 'Verifique os campos marcados.', shipNoteM: '\uD83D\uDD12 Seu endere\u00e7o vai somente para {m}, nunca para a Kallubi.', shipNote: '\uD83D\uDD12 Seu endere\u00e7o vai somente para a loja, nunca para a Kallubi.',
      shipVia: 'Enviado diretamente para {h}.', toPay: 'Continuar para o pagamento', shipTo: 'Entregar em', edit: 'Editar', shipSending: 'Enviando seu endere\u00e7o para a loja\u2026',
      shipSent: 'Endere\u00e7o enviado para a loja \u2713', shipFail: 'N\u00e3o foi poss\u00edvel enviar seu endere\u00e7o automaticamente.', shipMail: 'Enviar endere\u00e7o por e-mail \u2709',
      shipMailHint: 'Abre seu app de e-mail com o endere\u00e7o e o ID da transa\u00e7\u00e3o j\u00e1 preenchidos. \u00c9 s\u00f3 enviar.', shipKeep: 'Fale com a loja informando seu endere\u00e7o e o ID da transa\u00e7\u00e3o.',
      mailSubj: 'Pedido {o}: endere\u00e7o de entrega', mailHello: 'Ol\u00e1, este \u00e9 o meu endere\u00e7o de entrega para o meu pagamento em BSV:', eShipUrl: 'data-shipping-url deve ser uma URL https://',
      eShipMail: 'e-mail inv\u00e1lido em data-shipping-email',
      /* v1.2.0 */
      payFiat: 'Pagar {a}', fiatPrice: 'Pre\u00e7o: {f}', rateLine: '1 BSV = {r} \u00b7 cota\u00e7\u00e3o das {t}', rateFixed: 'Este valor vale at\u00e9 o temporizador terminar.',
      rateSrc: 'Fonte da cota\u00e7\u00e3o: {s}',
      quoting: 'Obtendo a cota\u00e7\u00e3o atual\u2026', rateH: 'Cota\u00e7\u00e3o indispon\u00edvel', rateP: 'N\u00e3o foi poss\u00edvel carregar uma cota\u00e7\u00e3o atual, por isso nenhum pagamento \u00e9 solicitado agora. Tente de novo em instantes.',
      lateH: 'O pagamento chegou tarde', lateP: 'Seu pagamento foi detectado depois do fim do prazo de pagamento. N\u00e3o pague de novo \u2013 fale com a loja informando o ID da transa\u00e7\u00e3o para que ela verifique o pagamento.', latePill: 'Fora do prazo',
      eFiat: 'valor inv\u00e1lido em data-amount-fiat (ex. "25.00", m\u00e1x. 2 casas decimais, 0.01 a 1000000.00)', eFiatCur: 'data-currency "{c}" n\u00e3o \u00e9 suportada com data-amount-fiat (EUR ou USD)',
      eBoth: 'use data-amount (BSV) ou data-amount-fiat, n\u00e3o os dois', eCurFiat: 'para pre\u00e7os em EUR ou USD use data-amount-fiat',
      eOrder: 'data-order-id inv\u00e1lido (1 a 64 caracteres: letras, d\u00edgitos e . _ - : / #)', eExp: 'data-expires-min inv\u00e1lido (minutos inteiros, 1 a 60)'
    }
  };
  var LANGS = Object.keys(I18N);
  /** "de-AT" / "DE" / " de_ch " -> "de"; unknown or empty -> null */
  function normLang(v) {
    var m = /^\s*([a-z]{2})(?:$|[-_\s])/i.exec(String(v == null ? '' : v));
    var l = m ? m[1].toLowerCase() : null;
    return l && Object.prototype.hasOwnProperty.call(I18N, l) ? l : null;
  }
  /** data-lang (explicit, 'auto' = page language) > nearest lang attribute (usually <html lang>) > 'en' */
  function pickLang(node) {
    var d = node && node.getAttribute ? clean(node.getAttribute('data-lang'), 20) : '';
    if (d && d.toLowerCase() !== 'auto') return normLang(d) || 'en';
    var host = node && node.closest ? node.closest('[lang]') : null;
    var pl = host ? host.getAttribute('lang') : (document.documentElement && document.documentElement.getAttribute('lang'));
    return normLang(pl) || 'en';
  }
  /** translate key with {placeholders}; falls back to English per key */
  function tr(lang, key, vars) {
    var tab = I18N[lang] || I18N.en, s = Object.prototype.hasOwnProperty.call(tab, key) ? tab[key] : I18N.en[key];
    return String(s).replace(/\{(\w+)\}/g, function (all, k) { return vars && vars[k] != null ? String(vars[k]) : all; });
  }

  /* ------------------------------------------------------------------ tiny safe DOM builder (no innerHTML ever) */
  function el(tag, attrs, kids) {
    var n = document.createElement(tag), k;
    if (attrs) for (k in attrs) if (attrs[k] != null && attrs[k] !== false) {
      if (k === 'text') n.textContent = attrs[k]; else n.setAttribute(k, attrs[k]);
    }
    (kids || []).forEach(function (c) { if (c != null) n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return n;
  }
  function svg(tag, attrs, kids) {
    var n = document.createElementNS(SVGNS, tag), k;
    for (k in attrs || {}) n.setAttribute(k, attrs[k]);
    (kids || []).forEach(function (c) { n.appendChild(c); });
    return n;
  }
  var uid = 0;
  // Official Kallubi logo (slanted gold K, 3 straight-edged strokes), vectorised from logo_x.jpg (IoU 0.995 at 400px).
  var KPATH = 'M40.7 5.65 26.8 20.46 26.8 52.8 40.7 38.14zM80.63 20.8 61.76 20.8 26.8 58.76 26.8 95.3 40.7 80.54 40.7 62.64zM57.4 50.95 47.26 61.75 66.96 83 87.23 83z';
  var KSTOPS = [['0', '#fde29c'], ['.11', '#fbdd95'], ['.28', '#efc472'], ['.5', '#e2b15c'], ['.67', '#c89546'], ['.83', '#a57532'], ['1', '#986d2e']];
  function logo(size) {
    var id = 'kg' + (++uid);
    return svg('svg', { viewBox: '0 0 100 100', width: size, height: size, class: 'klogo', 'aria-hidden': 'true' }, [
      svg('defs', {}, [svg('linearGradient', { id: id, gradientUnits: 'userSpaceOnUse', x1: '0', y1: '5', x2: '0', y2: '95' },
        KSTOPS.map(function (st) { return svg('stop', { offset: st[0], 'stop-color': st[1] }); }))]),
      svg('rect', { width: '100', height: '100', rx: '22', fill: '#000' }),
      svg('path', { fill: 'url(#' + id + ')', d: KPATH })]);
  }
  function icon(d, size, sw) {
    return svg('svg', { viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: 'currentColor', 'stroke-width': sw || '2.2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' },
      d.map(function (p) { return svg('path', { d: p }); }));
  }
  function qrSvg(text, label) {
    var q = qrcode(0, 'H'); q.addData(text, 'Byte'); q.make();
    var n = q.getModuleCount(), d = '';
    for (var r = 0; r < n; r++) for (var c = 0; c < n; c++) if (q.isDark(r, c)) d += 'M' + c + ' ' + r + 'h1v1h-1z';
    return svg('svg', { viewBox: '0 0 ' + n + ' ' + n, class: 'qr', 'shape-rendering': 'crispEdges', role: 'img', 'aria-label': label },
      [svg('path', { d: d, fill: '#14141c' })]);
  }

  /* ------------------------------------------------------------------ styles (Shadow DOM, isolated) */
  var CSS = [
    ':host{all:initial;display:block}',
    ':host(.sm){display:inline-block}',
    ':host(.kp-modal-host){display:block;position:fixed;inset:0;z-index:2147483000}',
    '*{box-sizing:border-box;margin:0;padding:0}',
    '.root{font-family:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased;line-height:1.35;color:var(--tx)}',
    /* dark (default) */
    '.t-dark,.t-auto{--tx:#f8fafc;--mut:#a8a29e;--cream:#fff3cf;--bg:#14141c;--mbg:linear-gradient(180deg,#1c1a20,#14141c 40%);--line:rgba(240,193,75,.18);--soft:#0f0f15;--row:#101016;--rowline:rgba(255,255,255,.05);--link:#f0c14b;--olbg:#0f0f15;--oltx:#f5d76e;--olbd:#f0c14b;--waitbg:rgba(240,193,75,.06);--timerbg:#0f0f15;--foot:rgba(0,0,0,.18);--xbg:rgba(255,255,255,.05);--bar:rgba(255,255,255,.07);--qrbg:#fffaf0;--shadow:0 30px 70px rgba(0,0,0,.6),0 0 60px rgba(240,193,75,.07);--overlay:rgba(8,8,12,.62);--copytx:#f5d76e}',
    '.t-light{--tx:#14141c;--mut:#6b6459;--cream:#14141c;--bg:#ffffff;--mbg:#ffffff;--line:rgba(184,134,11,.22);--soft:#faf8f2;--row:#faf8f2;--rowline:rgba(20,20,28,.06);--link:#b8860b;--olbg:#ffffff;--oltx:#b8860b;--olbd:#d4a017;--waitbg:#fdf8ea;--timerbg:#ffffff;--foot:#faf8f2;--xbg:rgba(20,20,28,.05);--bar:rgba(20,20,28,.07);--qrbg:#ffffff;--shadow:0 30px 70px rgba(20,20,28,.18),0 0 0 1px rgba(184,134,11,.08);--overlay:rgba(20,20,28,.38);--copytx:#b8860b}',
    '@media (prefers-color-scheme:light){.t-auto{--tx:#14141c;--mut:#6b6459;--cream:#14141c;--bg:#ffffff;--mbg:#ffffff;--line:rgba(184,134,11,.22);--soft:#faf8f2;--row:#faf8f2;--rowline:rgba(20,20,28,.06);--link:#b8860b;--olbg:#ffffff;--oltx:#b8860b;--olbd:#d4a017;--waitbg:#fdf8ea;--timerbg:#ffffff;--foot:#faf8f2;--xbg:rgba(20,20,28,.05);--bar:rgba(20,20,28,.07);--qrbg:#ffffff;--shadow:0 30px 70px rgba(20,20,28,.18),0 0 0 1px rgba(184,134,11,.08);--overlay:rgba(20,20,28,.38);--copytx:#b8860b}}',
    /* buttons */
    '.btn{display:flex;align-items:center;justify-content:center;gap:10px;font-weight:700;font-size:16px;line-height:1.2;font-family:inherit;border-radius:12px;padding:15px 20px;cursor:pointer;border:0;width:100%;letter-spacing:-.005em;text-decoration:none;white-space:nowrap;transition:transform .08s,filter .15s}',
    '.btn:hover{filter:brightness(1.05)}.btn:active{transform:translateY(1px)}.btn:focus-visible,.x:focus-visible,.copy:focus-visible,a:focus-visible{outline:2px solid #f0c14b;outline-offset:2px}',
    '.gold{background:linear-gradient(180deg,#f5d76e,#f0c14b 45%,#d4a017);color:#1a1408;box-shadow:0 0 0 1px rgba(255,243,207,.35) inset,0 8px 22px rgba(212,160,23,.32),0 2px 0 #b8860b}',
    '.outline{background:var(--olbg);color:var(--oltx);border:1.5px solid var(--olbd);box-shadow:0 0 18px rgba(240,193,75,.12)}',
    '.sm{width:auto;font-size:13px;padding:9px 14px;border-radius:9px;gap:7px}',
    '.bsv{width:22px;height:22px;border-radius:50%;background:#1a1408;color:#f0c14b;display:grid;place-items:center;font-size:13px;font-weight:800;flex:none}',
    '.outline .bsv{background:linear-gradient(135deg,#f5d76e,#d4a017);color:#1a1408}.sm .bsv{width:17px;height:17px;font-size:10px}',
    '.btn[disabled]{cursor:default;filter:saturate(.8);opacity:.9}',
    '.wrap{display:inline-flex;flex-direction:column;align-items:stretch;min-width:220px;width:100%}.wrap.small{min-width:0;width:auto}',
    '.pwr{white-space:nowrap;display:flex;justify-content:center;align-items:center;gap:6px;margin-top:8px;font-size:11.5px;color:var(--mut)}',
    '.pwr a,.mfoot a{color:var(--link);text-decoration:none;font-weight:600;display:inline-flex;align-items:center;gap:5px}',
    '.klogo{border-radius:22%;flex:none}',
    '.err{font-weight:600;font-size:12.5px;line-height:1.4;font-family:inherit;color:#b8860b;background:#fff7e0;border:1px dashed #d4a017;border-radius:10px;padding:10px 12px;max-width:360px}',
    /* modal */
    '.ov{position:fixed;inset:0;background:var(--overlay);-webkit-backdrop-filter:blur(3px);backdrop-filter:blur(3px);display:flex;align-items:center;justify-content:center;padding:16px;overflow:auto;animation:fade .15s ease-out}',
    '.modal:focus{outline:none}.modal{width:100%;max-width:400px;max-height:calc(100vh - 32px);overflow:auto;background:var(--mbg);border:1px solid var(--line);border-radius:22px;box-shadow:var(--shadow);animation:pop .18s ease-out}',
    '.mhead{display:flex;align-items:center;gap:12px;padding:16px 20px;border-bottom:1px solid var(--line)}',
    '.mhead .t{font-weight:700;font-size:15px}.mhead .s{font-size:12px;color:var(--mut);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:260px}',
    '.x{margin-left:auto;width:30px;height:30px;border-radius:8px;display:grid;place-items:center;color:var(--mut);background:var(--xbg);border:0;font-weight:600;font-size:15px;font-family:inherit;cursor:pointer;flex:none}',
    '.mbody{padding:20px 22px 20px}',
    '.amt{text-align:center}.amt .k{font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:var(--mut);font-weight:600}',
    '.amt .v{font-size:34px;font-weight:800;letter-spacing:-.02em;margin-top:4px;word-break:break-all}.amt .v small{font-size:17px;font-weight:700;color:#d4a017;margin-left:5px}',
    '.amt .sats{font-size:13px;color:var(--mut);margin-top:2px}.amt .tag{font-size:11.5px;color:var(--mut);margin-top:3px}',
    '.amt .fiat{font-size:14px;font-weight:700;color:var(--tx);margin-top:6px}.amt .rate{font-size:11.5px;color:var(--mut);margin-top:2px}',
    '.pill.late{background:linear-gradient(135deg,#fbe7a6,#e7c46a)}',
    '.qrwrap{margin:16px auto 14px;width:220px;height:220px;padding:13px;border-radius:18px;background:var(--qrbg);position:relative;box-shadow:0 0 0 1px rgba(240,193,75,.6),0 0 0 6px rgba(240,193,75,.08),0 14px 30px rgba(0,0,0,.25)}',
    '.qr{width:100%;height:100%;display:block}',
    '.ql{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);border-radius:11px;border:4px solid var(--qrbg);background:var(--qrbg);display:block;line-height:0}',
    '.addr{display:flex;align-items:center;gap:10px;background:var(--soft);border:1px solid var(--line);border-radius:11px;padding:9px 9px 9px 13px}',
    '.addr .lbl{font-size:10.5px;color:var(--mut);text-transform:uppercase;letter-spacing:.1em;font-weight:600;margin-bottom:2px}',
    '.addr .a{font:500 12.5px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:var(--cream);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.copy{font-weight:600;font-size:12.5px;font-family:inherit;color:var(--copytx);background:rgba(240,193,75,.12);border:1px solid rgba(240,193,75,.35);border-radius:8px;padding:8px 11px;display:flex;gap:6px;align-items:center;white-space:nowrap;cursor:pointer;flex:none}',
    '.mbody .btn{margin-top:12px}',
    '.wait{display:flex;align-items:center;gap:12px;margin-top:14px;padding:11px 13px;border-radius:12px;background:var(--waitbg);border:1px dashed rgba(240,193,75,.4)}',
    '.spin{width:22px;height:22px;border-radius:50%;border:2.5px solid rgba(240,193,75,.22);border-top-color:#f0c14b;border-right-color:#f0c14b;animation:spin 1s linear infinite;flex:none}',
    '.w1{font-size:14px;font-weight:600}.w2{font-size:12px;color:var(--mut)}',
    '.timer{margin-left:auto;font:700 15px ui-monospace,Menlo,Consolas,monospace;color:#d4a017;background:var(--timerbg);border-radius:8px;padding:6px 10px;border:1px solid rgba(240,193,75,.3)}',
    '.bar{height:4px;border-radius:4px;background:var(--bar);margin-top:10px;overflow:hidden}.bar i{display:block;height:100%;width:100%;background:linear-gradient(90deg,#b8860b,#f0c14b);transition:width 1s linear}',
    '.note{font-size:11.5px;color:var(--mut);text-align:center;margin-top:10px}',
    '.mfoot{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:12px 20px;border-top:1px solid var(--line);font-size:11.5px;color:var(--mut);background:var(--foot);border-radius:0 0 22px 22px}',
    '.ok{text-align:center;padding:8px 0 2px}',
    '.check{width:100px;height:100px;margin:8px auto 16px;border-radius:50%;background:radial-gradient(circle at 35% 30%,#f5d76e,#f0c14b 45%,#d4a017 80%,#b8860b);display:grid;place-items:center;color:#1a1408;box-shadow:0 0 0 8px rgba(240,193,75,.1),0 0 0 18px rgba(240,193,75,.05),0 0 60px rgba(240,193,75,.35)}',
    '.check.dim{background:radial-gradient(circle at 35% 30%,#fbe7a6,#e7c46a 60%,#c9a24a);box-shadow:0 0 0 8px rgba(240,193,75,.08)}',
    '.ok h2{font-size:24px;font-weight:800;letter-spacing:-.02em}.ok h2 span{color:#d4a017}.ok p{color:var(--mut);font-size:14px;margin-top:6px}',
    '.rows{margin-top:18px;border:1px solid var(--line);border-radius:14px;overflow:hidden;text-align:left}',
    '.row{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:11px 15px;font-size:13.5px;border-bottom:1px solid var(--rowline);background:var(--row)}.row:last-child{border-bottom:0}',
    '.row .k{color:var(--mut)}.row .v{font-weight:600;text-align:right}.row .v span{color:var(--mut);font-weight:500}',
    '.mono{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12.5px;color:var(--cream)}',
    '.pill{font-size:11.5px;font-weight:700;color:#1a1408;background:linear-gradient(135deg,#f5d76e,#f0c14b);padding:4px 9px;border-radius:999px;white-space:nowrap}',
    '.ok .btn{margin-top:10px}.ok .btn.outline{margin-top:16px}',
    '.btn[aria-disabled=true]{opacity:.55;cursor:not-allowed;pointer-events:none}',
    '.testnote{display:inline-block;margin:0 auto 10px;font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:#1a1408;background:linear-gradient(135deg,#f5d76e,#f0c14b);border-radius:999px;padding:4px 10px}',
    '.mt{min-width:0}.grow{flex:1;min-width:0}',
    '.seen{border-style:solid;border-color:rgba(240,193,75,.55)}.seen .w1{color:var(--tx)}',
    '.check.ring{position:relative}.check.ring:after{content:"";position:absolute;inset:-9px;border-radius:50%;border:3px solid rgba(240,193,75,.18);border-top-color:#f0c14b;animation:spin 1.6s linear infinite}',
    '.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}',
    /* v1.0.0 shipping address form (data-shipping) */
    '.sh{font-size:19px;font-weight:800;letter-spacing:-.015em}.ssub{font-size:13px;color:var(--mut);margin-top:3px}',
    '.samt{font-size:12.5px;color:var(--mut);margin-top:6px}.samt b{color:var(--tx);font-weight:700}',
    '.fld{margin-top:10px;min-width:0}.fld label{display:block;font-size:12px;font-weight:600;color:var(--mut);margin-bottom:4px}',
    '.in{display:block;width:100%;font-family:inherit;font-size:14px;line-height:1.3;color:var(--tx);background:var(--soft);border:1px solid var(--line);border-radius:10px;padding:10px 12px;outline:none;-webkit-appearance:none;appearance:none}',
    '.in:focus{border-color:#f0c14b;box-shadow:0 0 0 3px rgba(240,193,75,.18)}.in[aria-invalid=true]{border-color:#e5484d;box-shadow:0 0 0 3px rgba(229,72,77,.14)}',
    'textarea.in{resize:vertical;min-height:54px}',
    '.two{display:grid;grid-template-columns:2fr 3fr;gap:10px}',
    '.fe{font-size:11.5px;font-weight:600;color:#e5484d;margin-top:3px}.fe:empty{display:none}',
    '.priv{margin-top:14px;font-size:12px;line-height:1.45;color:var(--mut);background:var(--waitbg);border:1px dashed rgba(240,193,75,.4);border-radius:10px;padding:9px 11px}',
    '.ferr{font-size:12.5px;font-weight:600;color:#e5484d;text-align:center;margin-top:8px}.ferr:empty{display:none}',
    '.shiprow{display:flex;align-items:center;gap:8px;margin-top:12px;font-size:12.5px;color:var(--mut)}.shiprow .sv{color:var(--tx);font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1;min-width:0}',
    '.lnk{font-family:inherit;font-size:12.5px;font-weight:600;color:var(--link);background:none;border:0;cursor:pointer;padding:2px 4px;flex:none}.lnk:focus-visible{outline:2px solid #f0c14b;outline-offset:2px}',
    '.shipbox{margin-top:14px}.shs{display:flex;align-items:center;justify-content:center;gap:8px;font-size:13px;font-weight:600}.shs.good{color:#16a34a}.shs.bad{color:#e5484d}.shs .spin{width:16px;height:16px;border-width:2px}',
    '@media (max-width:480px){.in{font-size:16px}}',
    '@keyframes spin{to{transform:rotate(360deg)}}@keyframes fade{from{opacity:0}}@keyframes pop{from{opacity:0;transform:translateY(8px) scale(.98)}}',
    '@media (prefers-reduced-motion:reduce){.spin{animation-duration:3s}.ov,.modal{animation:none}}'
  ].join('');

  var sheet = null;
  /** Adds the widget CSS to a shadow root. Uses a constructable stylesheet where supported (works under a strict
   *  style-src CSP without 'unsafe-inline'); falls back to a <style> element. */
  function addStyle(root) {
    try {
      if (!sheet && root.adoptedStyleSheets !== undefined && typeof CSSStyleSheet === 'function' && CSSStyleSheet.prototype.replaceSync) { sheet = new CSSStyleSheet(); sheet.replaceSync(CSS); }
      if (sheet) { root.adoptedStyleSheets = [sheet]; return; }
    } catch (e) { sheet = null; }
    var st = document.createElement('style'); st.textContent = CSS; root.appendChild(st);
  }

  /* ------------------------------------------------------------------ payment watchers */
  function getJson(url) {
    var ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var t = ctl ? setTimeout(function () { ctl.abort(); }, 9000) : 0;
    return fetch(url, { credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer', signal: ctl ? ctl.signal : undefined })
      .then(function (r) {
        clearTimeout(t);
        if (r.status === 404) return { __404: true };
        if (!r.ok) { var e = new Error('HTTP ' + r.status); e.status = r.status; throw e; }
        return r.json();
      }, function (e) { clearTimeout(t); throw e; });
  }
  function hashes(j) { var a = Array.isArray(j) ? j : (j && Array.isArray(j.result) ? j.result : []); return a.map(function (x) { return x && x.tx_hash; }).filter(function (h) { return /^[0-9a-f]{64}$/.test(h || ''); }); }

  function postText(url, body) {
    var ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var t = ctl ? setTimeout(function () { ctl.abort(); }, 12000) : 0;
    return fetch(url, { method: 'POST', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer',
      headers: { 'Content-Type': 'text/plain' }, body: body, signal: ctl ? ctl.signal : undefined })
      .then(function (r) {
        clearTimeout(t);
        return r.text().then(function (txt) {
          var j = null; try { j = txt ? JSON.parse(txt) : null; } catch (e) { j = { raw: txt }; }
          return { ok: r.ok, status: r.status, body: j };
        });
      }, function (e) { clearTimeout(t); throw e; });
  }
  function fetchParentHex(o, txid) {
    var srcs = [];
    if (o.node) srcs.push(o.node + '/tx/' + txid + '/hex');
    if (o.fallback) srcs.push(o.fallback + '/tx/' + txid + '/hex');
    return srcs.reduce(function (p, url) {
      return p.then(function (r) {
        if (r) return r;
        return getText(url).then(function (hex) {
          var b = hexBytes(hex); if (!b || txidOf(b) !== txid) return null;
          try { return { hex: hex, tx: parseTx(b) }; } catch (e) { return null; }
        }, function () { return null; });
      });
    }, Promise.resolve(null));
  }
  function loadPrevouts(o, tx) {
    return tx.inputs.reduce(function (chain, inp) {
      return chain.then(function (acc) {
        if (!acc) return null;
        return fetchParentHex(o, inp.prevTxid).then(function (p) {
          if (!p || !p.tx.outputs[inp.vout]) return null;
          acc.push(p.tx.outputs[inp.vout]); return acc;
        });
      });
    }, Promise.resolve([]));
  }
  function parsePolicyRate(j) {
    var f = j && j.policy && j.policy.miningFee, sat = Number(f && f.satoshis), bytes = Number(f && f.bytes);
    if (sat >= 1 && bytes >= 1) return Math.ceil(sat * 1000 / bytes);
    return null;
  }
  /** Submit the already-seen raw payment to BSV Broadcaster (same bytes, or EF when prevouts are known) and watch
   *  for SEEN_ON_NETWORK / MINED / IMMUTABLE with no competingTxs, or DOUBLE_SPEND_ATTEMPTED, for watchMs. */
  function quickCheck(o) {
    var hex = o.hex, txid = o.txid, roots = o.roots || BROADCASTERS, watchMs = o.watchMs || QUICK_WATCH_MS, started = Date.now();
    var b = hexBytes(hex), tx, outFee, prevouts;
    if (!b || txidOf(b) !== txid) return Promise.resolve({ ok: false, reason: 'hex' });
    try { tx = parseTx(b); } catch (e) { return Promise.resolve({ ok: false, reason: 'hex' }); }
    if (!isTxFinal(tx, o.nowS, o.tipHeight)) return Promise.resolve({ ok: false, reason: 'not_final', hard: true, tx: tx });
    if (tx.inputs.length > QUICK_MAX_INPUTS) return Promise.resolve({ ok: false, reason: 'fee_unknown', inputs: tx.inputs.length });
    var budget = new Promise(function (res) { setTimeout(function () { res(null); }, o.prevBudgetMs || QUICK_PREV_BUDGET_MS); });
    return Promise.race([loadPrevouts({ node: o.node, fallback: o.fallback }, tx), budget]).then(function (prev) {
      prevouts = prev;
      var fee = null;
      if (prev && prev.length === tx.inputs.length) {
        var inS = 0, outS = 0, i;
        for (i = 0; i < prev.length; i++) inS += prev[i].value;
        for (i = 0; i < tx.outputs.length; i++) outS += tx.outputs[i].value;
        // verified parents that pay less than the outputs = invalid tx: never 0-conf
        if (inS < outS) return { ok: false, reason: 'bad_amounts', hard: true };
        fee = inS - outS;
      }
      outFee = fee;
      function policies(i) {
        if (i >= roots.length) return Promise.resolve(FEE_SAT_PER_KB);
        return getJson(roots[i] + '/policy').then(function (j) {
          var r = parsePolicyRate(j); return r != null ? r : policies(i + 1);
        }, function () { return policies(i + 1); });
      }
      return policies(0).then(function (satPerKb) {
        if (fee == null) return { ok: false, reason: 'fee_unknown', satPerKb: satPerKb, tx: tx };
        if (!feeSufficient(fee, tx.size, satPerKb)) return { ok: false, reason: 'low_fee', hard: true, fee: fee, satPerKb: satPerKb, size: tx.size, tx: tx };
        var ef = prevouts ? toEf(hex, prevouts) : null;
        function submit(i) {
          if (i >= roots.length) return Promise.resolve({ ok: false, reason: 'arc_unavailable' });
          var root = roots[i], bodies = ef ? [ef, hex] : [hex], bi = 0;
          function tryBody() {
            if (bi >= bodies.length) return submit(i + 1);
            var body = bodies[bi++];
            return postText(root + '/tx', body).then(function (r) {
              var st = r.body && (r.body.txStatus || (r.body.error && String(r.body.error)));
              if (r.ok) {   // 2xx only; any other answer = try the next body / endpoint
                var parsed = statusResult(r.body || {});
                if (parsed.bad) return { ok: false, reason: 'double_spend', hard: true, txStatus: parsed.txStatus, competingTxs: parsed.competingTxs, endpoint: root };
                return watch(root, parsed);
              }
              if (r.status === 404 || r.status >= 500 || r.status === 429) return tryBody();
              return tryBody();
            }, function () { return tryBody(); });
          }
          return tryBody();
        }
        function watch(root, last) {
          function once() {
            return getJson(root + '/tx/' + txid).then(function (j) { return statusResult(j); }, function () { return { error: true }; });
          }
          function loop(prevSt) {
            if (prevSt && prevSt.bad) return { ok: false, reason: 'double_spend', hard: true, txStatus: prevSt.txStatus, competingTxs: prevSt.competingTxs, endpoint: root, fee: fee };
            if (Date.now() - started >= watchMs) {
              if (prevSt && prevSt.ok) return { ok: true, txStatus: prevSt.txStatus, endpoint: root, fee: fee, satPerKb: satPerKb, size: tx.size };
              return { ok: false, reason: prevSt && prevSt.missing ? 'arc_unknown' : 'arc_pending', txStatus: prevSt && prevSt.txStatus, endpoint: root };
            }
            return new Promise(function (res) { setTimeout(res, QUICK_POLL_MS); }).then(once).then(loop);
          }
          return loop(last);
        }
        return submit(0);
      });
    });
  }

  function getText(url) {
    var ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var t = ctl ? setTimeout(function () { ctl.abort(); }, 15000) : 0;
    return fetch(url, { credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer', signal: ctl ? ctl.signal : undefined })
      .then(function (r) {
        if (r.status === 404) { clearTimeout(t); return null; }
        if (!r.ok) { clearTimeout(t); var e = new Error('HTTP ' + r.status); e.status = r.status; throw e; }
        if (Number(r.headers.get('content-length') || 0) > MAX_TX_HEX + 2) { clearTimeout(t); if (ctl) ctl.abort(); throw new Error('too large'); }
        return r.text().then(function (x) { clearTimeout(t); return x.length > MAX_TX_HEX + 2 ? null : x.trim(); });
      }, function (e) { clearTimeout(t); throw e; });
  }
  var noop = function () { return null; };
  /** Raw hex of tx h, verified against h: own node first, then the fallback. Resolves {sats} or null (not available yet). */
  function fetchVerified(o, h) {
    var srcs = [];
    if (o.node) srcs.push(o.node + '/tx/' + h + '/hex');
    if (o.fallback) srcs.push(o.fallback + '/tx/' + h + '/hex');
    return srcs.reduce(function (p, url) {
      return p.then(function (r) {
        if (r) return r;
        return getText(url).then(function (hex) {
          var sats = hex == null ? null : verifiedSats(hex, h, o.script);
          if (sats == null) return null;
          return { sats: sats, hex: hex, source: o.node && url.indexOf(o.node) === 0 ? 'node' : 'fallback' };
        }, noop);
      });
    }, Promise.resolve(null));
  }
  /** Confirmations + block time of tx h. known=false when no reachable source knows the tx (404 everywhere). */
  function txStatus(o, h) {
    var srcs = [], errors = 0;
    if (o.node) srcs.push(o.node + '/tx/' + h);
    if (o.fallback) srcs.push(o.fallback + '/tx/hash/' + h);
    return srcs.reduce(function (p, url) {
      return p.then(function (r) {
        if (r) return r;
        return getJson(url).then(function (tx) {
          if (!tx || tx.__404) return null;
          if (String(tx.txid || tx.hash || '').toLowerCase() !== h) { errors++; return null; }
          var n = Math.floor(Number(tx.confirmations)); if (!(n > 0) || tx.orphaned) n = 0;   // mempool, unknown or orphaned block: 0
          return { known: true, confirmations: n, blocktime: n > 0 ? Number(tx.blocktime || tx.time || 0) || 0 : 0 };
        }, function () { errors++; return null; });
      });
    }, Promise.resolve(null)).then(function (r) {
      if (r || !o.node || !o.address) return r || { known: false, unreachable: errors > 0, confirmations: 0, blocktime: 0 };
      // node without txindex answers 404 for confirmed txs: ask its address index (height) + chain tip instead
      return getJson(o.node + '/address/' + o.address + '/history?limit=20').then(function (j) {
        var all = j && !j.__404 ? [].concat(Array.isArray(j.unconfirmed) ? j.unconfirmed : [], Array.isArray(j.confirmed) ? j.confirmed : []) : [], e = null;
        for (var i = 0; i < all.length; i++) if (all[i] && all[i].tx_hash === h) { e = all[i]; break; }
        if (!e) return { known: false, unreachable: errors > 0 || !j, confirmations: 0, blocktime: 0 };   // no index (404) = no extra information
        var height = Math.floor(Number(e.height));
        if (!(height > 0)) return { known: true, confirmations: 0, blocktime: 0 };
        return getJson(o.node + '/chain/info').then(function (ci) {
          var tip = Math.floor(Number(ci && ci.blocks)), n = tip >= height ? tip - height + 1 : 0;
          return { known: true, confirmations: n, blocktime: 0 };
        }, function () { return { known: true, confirmations: 0, blocktime: 0 }; });
      }, function () { return { known: false, unreachable: true, confirmations: 0, blocktime: 0 }; });
    });
  }
  function historyHashes(j) {
    var out = [];
    if (j && typeof j === 'object' && !Array.isArray(j)) { out = out.concat(hashes(j.unconfirmed || []), hashes(j.confirmed || [])); }
    return out;
  }

  /** Direct mode: the buyer's browser reads the chain itself (own node first, public fallback where needed). */
  function Watcher(o) {
    this.o = o; this.baseline = null; this.checked = {}; this.queue = []; this.n = 0; this.initTries = 0;
    this.addrNode = !!o.node;                // switches to the fallback for good once the node says "no address index"
  }
  Watcher.prototype.fallbackLists = function (withConfirmed) {
    var a = this.o.address, base = this.o.fallback;
    if (!base) return Promise.reject(new Error('no address source'));
    var ps = [getJson(base + '/address/' + a + '/unconfirmed/history')];
    if (withConfirmed) ps.push(getJson(base + '/address/' + a + '/confirmed/history?order=desc&limit=20'));
    return Promise.all(ps).then(function (rs) { var out = []; rs.forEach(function (r) { out = out.concat(hashes(r)); }); return out; });
  };
  Watcher.prototype.lists = function (withConfirmed) {
    var self = this;
    if (!this.addrNode) return this.fallbackLists(withConfirmed);
    return getJson(this.o.node + '/address/' + this.o.address + '/history?limit=20').then(function (j) {
      if (j && j.__404) { self.addrNode = false; return self.fallbackLists(withConfirmed); }
      return historyHashes(j);
    }, function (e) { return self.o.fallback ? self.fallbackLists(withConfirmed) : Promise.reject(e); });   // node down: this step via the fallback
  };
  /** one poll step; resolves to a match {txid,sats,confirmations} or null */
  Watcher.prototype.step = function () {
    var self = this, o = this.o;
    if (!this.baseline) {
      return this.lists(true).then(function (hs) {
        self.baseline = {}; hs.forEach(function (h) { self.baseline[h] = 1; }); return null;
      }, function (e) {
        if (++self.initTries >= 3) self.baseline = {};   // fall back to since-time + unique amount only
        throw e;
      });
    }
    this.n++;
    var p = this.queue.length ? Promise.resolve([]) : this.lists(this.n % 4 === 0);
    return p.then(function (hs) {
      hs.forEach(function (h) { if (!self.baseline[h] && !self.checked[h] && !(o.used && o.used[h]) && self.queue.indexOf(h) < 0) self.queue.push(h); });
      var batch = self.queue.splice(0, 3);
      return batch.reduce(function (chain, h) {
        return chain.then(function (found) {
          if (found) { self.queue.unshift(h); return found; }
          return inspectTx(o, h).then(function (m) {
            if (m === undefined) return null;     // not available yet: not marked checked, so the next list run re-queues it
            self.checked[h] = 1; return m;
          });
        });
      }, Promise.resolve(null));
    });
  };
  /** undefined = not available yet, null = not a payment for this invoice, else the match */
  function inspectTx(o, h) {
    return fetchVerified(o, h).then(function (r) {
      if (!r) return undefined;
      if (r.sats < o.sats) return null;
      return txStatus(o, h).then(function (st) {
            var m = matchTx({ txid: h, confirmations: st.confirmations, blocktime: st.blocktime }, h, o, r.sats);
            if (m) { m.hex = r.hex; m.source = r.source; }
            return m;
          });
    });
  }
  /** tx: {txid, confirmations, blocktime}; sats: verified amount from the raw tx */
  function matchTx(tx, h, o, sats) {
    if (!tx || String(tx.txid || '').toLowerCase() !== h || !/^[0-9a-f]{64}$/.test(h)) return null;
    var bt = Number(tx.blocktime || 0);
    if (bt && bt < o.since - 600) return null;          // mined before the invoice existed (10 min clock slack)
    if (!(typeof sats === 'number' && sats >= o.sats && sats <= MAX_SATS)) return null;
    return { txid: h, sats: sats, confirmations: Math.max(0, Math.floor(Number(tx.confirmations) || 0)) };
  }

  /** Proxy mode: browser -> Kallubi worker (/api/pay/check), shared edge cache + rate limit. */
  function ApiWatcher(o) { this.o = o; this.baseline = null; }
  ApiWatcher.prototype.step = function () {
    var self = this, o = this.o;
    var u = o.api + (o.api.indexOf('?') < 0 ? '?' : '&') + 'to=' + encodeURIComponent(o.address) + '&amount=' + o.sats + '&since=' + o.since;
    return getJson(u).then(function (j) {
      var ms = j && Array.isArray(j.matches) ? j.matches : []; self.last = ms;
      if (!self.baseline) { self.baseline = {}; ms.forEach(function (m) { self.baseline[m.txid] = 1; }); return null; }
      var cand = null;
      for (var i = 0; i < ms.length; i++) {
        var m = ms[i];
        if (m && /^[0-9a-f]{64}$/.test(m.txid) && !self.baseline[m.txid] && !(o.used && o.used[m.txid]) && Number(m.sats) >= o.sats) { cand = m; break; }
      }
      if (!cand) return null;
      // The worker's JSON is only a hint: the amount is re-checked from the raw tx (hash = txid) like in direct mode.
      if (!o.node && !o.fallback) return null;
      return fetchVerified(o, cand.txid).then(function (r) {
        if (!r || r.sats < o.sats) return null;
        // confirmations from the node / fallback status, not from the worker
        return txStatus({ node: o.node, fallback: o.fallback, address: o.address }, cand.txid).then(function (st) {
          return { txid: cand.txid, sats: r.sats, confirmations: st && st.known ? st.confirmations : 0, hex: r.hex, source: r.source };
        });
      });
    });
  };

  /* ------------------------------------------------------------------ the widget */
  function readConfig(node) {
    var d = node.dataset, errs = [];
    var address = clean(d.to, 40), inspected = inspectAddress(address), script = inspected.script || null;
    if (!script) errs.push([inspected.error || 'eTo']);
    // v1.2.0: data-amount-fiat + data-currency="EUR|USD" -> converted to sats at the current rate when the dialog opens.
    // Without data-amount-fiat everything below behaves exactly like before (BSV amount, data-currency must be BSV).
    var has = function (v) { return v != null && String(v).trim() !== ''; };
    var fiat = has(d.amountFiat), fiatCents = null, baseSats = null, cur;
    if (fiat) {
      cur = clean(d.currency, 8).toUpperCase();
      if (has(d.amount)) errs.push(['eBoth']);
      fiatCents = parseFiat(d.amountFiat); if (fiatCents == null) errs.push(['eFiat']);
      if (!FIATS[cur]) errs.push(['eFiatCur', { c: cur || '\u2013' }]);
    } else {
      var amtErr = amountError(d.amount); baseSats = amtErr ? null : parseAmount(d.amount);
      if (amtErr) errs.push([amtErr]);
      cur = clean(d.currency || 'BSV', 8).toUpperCase();
      if (cur !== 'BSV') { errs.push(['eCur', { c: cur }]); if (FIATS[cur]) errs.push(['eCurFiat']); }
    }
    var theme = /^(light|dark|auto)$/.test(d.theme || '') ? d.theme : 'auto';
    var ttl = Math.round(Number(d.ttl)); if (!(ttl >= 3 && ttl <= 3600)) ttl = DEFAULT_TTL_S;
    // v1.2.0: data-expires-min (whole minutes 1-60) wins over the older data-ttl (seconds)
    if (has(d.expiresMin)) { var em = String(d.expiresMin).trim(); if (/^\d{1,2}$/.test(em) && +em >= 1 && +em <= 60) ttl = +em * 60; else errs.push(['eExp']); }
    // v1.2.0: data-order-id is validated strictly (it ends up in events, POSTs and e-mails); the older data-order stays as it was
    var orderId = '';
    if (has(d.orderId)) { orderId = parseOrderId(d.orderId); if (!orderId) { errs.push(['eOrder']); orderId = ''; } }
    // Confirmation policy: data-confirm-above-fiat is an EUR amount (default 200.00). 0 = always wait for 1 block.
    // USD prices convert that EUR amount with the ECB rate; BSV prices convert it with the EUR/BSV rate.
    // An explicit data-confirm-above (BSV) is a shop override and cannot be combined with data-confirm-above-fiat.
    var confirmAboveSet = has(d.confirmAbove), confirmAboveFiatSet = has(d.confirmAboveFiat);
    var confirmAbove = confirmAboveSet ? parseThreshold(d.confirmAbove) : null;
    if (confirmAboveSet && confirmAbove == null) errs.push(['eConf']);
    var cf = confirmAboveFiatSet ? String(d.confirmAboveFiat).trim() : null;
    var confirmAboveFiat = cf == null ? DEFAULT_CONFIRM_ABOVE_FIAT : /^0+(\.0{1,2})?$/.test(cf) ? 0 : parseFiat(cf);
    if (confirmAboveFiatSet && confirmAboveFiat == null) { errs.push(['eConfFiat']); confirmAboveFiat = 0; }
    if (confirmAboveSet && (fiat || confirmAboveFiatSet)) errs.push(['eConfBoth']);
    var urlOk = function (v) { return /^https:\/\/[^\s"'<>]+$|^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/[^\s"'<>]*$/.test(v); };
    var nodeApi = d.node == null ? NODE_API : clean(d.node, 300).replace(/\/+$/, '');        // data-node="" disables the own node
    if (nodeApi && !urlOk(nodeApi)) { if (window.console) console.warn('[Kallubi Pay] ignoring invalid data-node'); nodeApi = NODE_API; }
    var fallback = d.fallback === '0' || d.fallback === 'false' ? '' : d.fallbackUrl ? clean(d.fallbackUrl, 300).replace(/\/+$/, '') : FALLBACK_API;
    if (fallback && !urlOk(fallback)) { if (window.console) console.warn('[Kallubi Pay] ignoring invalid data-fallback-url'); fallback = FALLBACK_API; }
    var api = clean(d.api, 300); if (api && !/^https:\/\/[^\s"'<>]+$|^\/[^\s"'<>]*$|^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/[^\s"'<>]*$/.test(api)) { errs.push(['eApi']); api = ''; }
    // v1.0.0 optional shipping address. Off by default; the extra attributes are only read when data-shipping="1".
    var shipping = d.shipping === '1' || d.shipping === 'true', shipUrl = '', shipHost = '', shipMail = '';
    if (shipping) {
      shipUrl = clean(d.shippingUrl, 500);
      if (shipUrl) { shipHost = shipUrlHost(shipUrl); if (!shipHost) { errs.push(['eShipUrl']); shipUrl = ''; shipHost = ''; } }
      shipMail = clean(d.shippingEmail, 120);
      if (shipMail && !isEmail(shipMail)) { errs.push(['eShipMail']); shipMail = ''; }
    }
    return {
      errors: errs, lang: pickLang(node), address: address, script: script, baseSats: baseSats, theme: theme,
      style: d.style === 'outline' ? 'outline' : 'gold', size: d.size === 'sm' ? 'sm' : '',
      label: clean(d.label, 80), merchant: clean(d.merchant, 60), order: orderId || clean(d.order, 40), orderId: orderId,
      fiat: fiat && fiatCents != null ? { cents: fiatCents, cur: cur } : null,
      text: clean(d.buttonText, 40), showAmount: d.showAmount === '1' || d.showAmount === 'true',
      onPaid: clean(d.onPaid, 80), test: d.test === '1' || d.test === 'true',
      unique: !(d.unique === '0' || d.unique === 'false'), ttl: ttl, api: api, node: nodeApi, fallback: fallback,
      testDelay: Math.max(500, Math.min(60000, Number(d.testDelay) || TEST_DELAY_MS)),
      testConfirmDelay: Math.max(500, Math.min(600000, Number(d.testConfirmDelay) || TEST_DELAY_MS)),
      confirmAbove: confirmAbove, confirmAboveFiat: confirmAboveFiat, shipping: shipping, shipUrl: shipUrl, shipHost: shipHost, shipMail: shipMail,
      pollMs: Math.max(1000, Math.min(60000, Math.round(Number(d.pollMs)) || POLL_MS)),
      broadcasters: (function () {
        var u = clean(d.broadcasterUrl, 300).replace(/\/+$/, '');
        if (!u) return BROADCASTERS.slice();
        if (!urlOk(u)) { if (window.console) console.warn('[Kallubi Pay] ignoring invalid data-broadcaster-url'); return BROADCASTERS.slice(); }
        return [u];
      })(),
      quickMs: (function () {
        var n = Math.round(Number(d.quickMs));
        return n >= QUICK_MIN_MS && n <= 15000 ? n : QUICK_WATCH_MS;
      })()
    };
  }

  function Widget(node) {
    this.node = node; this.cfg = readConfig(node); this.inv = null; this.modal = null; this.paid = null; this.ship = null;
    this.used = USED_TX; // txids that already paid an invoice on this page (any button): never counted twice
    this.host = el('span', { class: 'kallubi-pay-host' + (this.cfg.size ? ' sm' : '') });
    this.root = this.host.attachShadow({ mode: 'open' });
    node.textContent = '';
    node.appendChild(this.host);
    this.render();
  }
  Widget.prototype.themeClass = function () { return 'root t-' + this.cfg.theme; };
  Widget.prototype.t = function (key, vars) { return tr(this.cfg.lang, key, vars); };
  Widget.prototype.render = function () {
    var c = this.cfg, self = this;
    this.root.textContent = ''; addStyle(this.root);
    if (c.errors.length) {
      var msg = function (l) { return c.errors.map(function (e) { return tr(l, e[0], e[1]); }).join('; '); };
      var box = el('div', { class: 'root err', role: 'alert', lang: c.lang }, ['\u26a0 Kallubi Pay: ' + msg(c.lang)]);
      this.root.appendChild(box);
      if (window.console) console.warn('[Kallubi Pay] ' + msg('en'), this.node);   // developer log stays English
      return;
    }
    var txt = this.paid ? this.t('paidBtn') : this.inv && this.inv.state === 'seen' ? this.t('seenBtn') : (c.text || (c.showAmount ? (c.fiat ? this.t('payFiat', { a: fmtFiat(c.fiat.cents, c.fiat.cur, c.lang) }) : this.t('payAmount', { a: fmtBsv(c.baseSats) })) : this.t('payWith')));
    this.btn = el('button', { type: 'button', class: 'btn ' + c.style + (c.size ? ' sm' : ''), part: 'button', 'aria-haspopup': 'dialog', disabled: this.paid ? 'disabled' : null },
      [el('span', { class: 'bsv', 'aria-hidden': 'true', text: '\u20bf' }), el('span', { text: txt })]);
    this.btn.addEventListener('click', function () { self.open(); });
    var pwr = el('div', { class: 'pwr' }, [logo(14), this.t('poweredBy') + ' ', el('a', { href: KALLUBI_URL, target: '_blank', rel: 'noopener noreferrer', text: 'Kallubi' })]);
    this.root.appendChild(el('div', { class: this.themeClass() + ' wrap' + (c.size ? ' small' : ''), lang: c.lang }, [this.btn, pwr]));
  };

  /** q = fiat quote {sats, rate, micro, ts, source} (v1.2.0) or undefined for a plain BSV amount */
  Widget.prototype.newInvoice = function (q) {
    var c = this.cfg, off = c.unique ? 1 + rnd(99) : 0;
    var sats = Math.min(MAX_SATS, (q ? q.sats : c.baseSats) + off);
    var now = Date.now();
    this.inv = { sats: sats, offset: off, since: Math.floor(now / 1000), deadline: now + c.ttl * 1000, state: 'waiting',
      ref: c.orderId || (ORDER_RE.test(c.order) ? c.order : '') || genRef(), refGenerated: !c.orderId && !ORDER_RE.test(c.order), quote: q || null };
    this.startWatch();
  };
  /** an invoice that is still payable (not expired) */
  Widget.prototype.live = function () { return this.inv && this.inv.state === 'waiting' && Date.now() < this.inv.deadline; };
  /** start a new invoice and show it. Fiat: fetch a fresh rate first; no fresh rate = no QR (rate error view). */
  Widget.prototype.loadThresholdFx = function (inv) {
    var self = this, c = this.cfg;
    if (!inv || c.test || (c.confirmAbove != null && !c.fiat)) return;   // test mode stays offline; explicit BSV threshold needs no rate
    fetchRate('EUR', !!c.fallback).then(function (r) {
      if (self.inv !== inv) return;
      attachFx(inv, { cur: 'EUR', micro: r.micro, rate: r.rate, source: r.source, ts: r.ts, usdRate: r.usdRate, ecbRate: r.ecbRate, ecbDate: r.ecbDate });
    }, function () {});
  };
  Widget.prototype.startInvoice = function (onReady) {
    var self = this, c = this.cfg;
    if (!c.fiat) { this.newInvoice(); this.loadThresholdFx(this.inv); if (onReady) onReady(); this.showModal('waiting'); return; }
    var seq = this.quoteSeq = (this.quoteSeq || 0) + 1;
    this.quoting = true; this.showModal('quoting');
    var rateP = fetchRate(c.fiat.cur, !!c.fallback);
    var ecbP = c.fiat.cur === 'USD' ? fetchEcb().then(null, function () { return null; }) : Promise.resolve(null);
    Promise.all([rateP, ecbP]).then(function (arr) {
      var r = arr[0], ecb = arr[1];
      if (seq !== self.quoteSeq) return;
      var sats = fiatToSats(c.fiat.cents, r.micro);
      if (sats == null) throw new Error('rate');
      self.quoting = false;
      self.newInvoice({ sats: sats, rate: r.rate, micro: r.micro, ts: r.ts, source: r.source, usdRate: r.usdRate, ecbRate: r.ecbRate, ecbDate: r.ecbDate, cur: c.fiat.cur });
      attachFx(self.inv, { cur: c.fiat.cur, micro: r.micro, rate: r.rate, source: r.source, ts: r.ts, usdRate: r.usdRate, ecbRate: r.ecbRate, ecbDate: r.ecbDate }, ecb);
      if (onReady) onReady();
      if (self.modal) self.showModal('waiting');
    }).then(null, function () {
      if (seq !== self.quoteSeq) return;
      self.quoting = false;
      if (self.modal) self.showModal('rate');
    });
  };
  Widget.prototype.open = function () {
    if (this.cfg.errors.length) return;
    if (this.paid) { this.showModal('paid'); return; }
    if (this.inv && (this.inv.state === 'seen' || this.inv.state === 'checking')) { this.showModal(this.inv.state === 'checking' ? 'checking' : 'confirming'); return; }
    if (this.inv && this.inv.state === 'late') { this.showModal('late'); return; }   // never offer a second payment after a late one
    if (this.inv && this.inv.state === 'dropped') { this.showModal('dropped'); return; }
    if (this.cfg.shipping && !this.ship) { this.showModal('shipping'); return; }   // v1.0.0: address first, the invoice starts after it
    if (this.quoting) { this.showModal('quoting'); return; }
    if (!this.live()) { this.startInvoice(); return; }
    this.showModal('waiting');
  };
  Widget.prototype.uri = function () {
    var c = this.cfg, q = 'amount=' + fmtBsv(this.inv.sats);
    var lab = c.label || c.merchant; if (lab) q += '&label=' + encodeURIComponent(lab);
    return 'bitcoin:' + c.address + '?' + q;
  };

  Widget.prototype.startWatch = function () {
    var self = this, inv = this.inv, c = this.cfg;
    this.stopWatch();
    var o = { address: c.address, script: c.script, sats: inv.sats, since: inv.since, api: c.api, node: c.node, fallback: c.fallback, used: this.used };
    inv.tick = setInterval(function () { self.tick(); }, 1000);
    if (c.test) {
      inv.testT = setTimeout(function () {
        var h = ''; for (var i = 0; i < 64; i++) h += '0123456789abcdef'[rnd(16)];
        self.found(inv, { txid: h, sats: inv.sats, confirmations: 0, test: true });
      }, c.testDelay);
      return;
    }
    var POLL = c.pollMs, w = c.api ? new ApiWatcher(o) : new Watcher(o), delay = POLL;
    inv.watcher = w;
    var loop = function () {
      if (!self.watching(inv)) return;
      w.step().then(function (m) {
        delay = POLL;
        if (m) {
          self.found(inv, m);
          // a match that was ignored (already counted for another invoice/button) must not end the watch
          if (self.watching(inv)) { if (w.baseline) w.baseline[m.txid] = 1; schedule(POLL); }
          return;
        }
        schedule(inv.watcherFirst ? POLL : 400);
        inv.watcherFirst = true;
      }, function (e) {
        delay = Math.min(POLL_MAX_MS, delay * 2);     // back off on 429 / network errors
        schedule(delay);
      });
    };
    var schedule = function (ms) {
      if (!self.watching(inv)) return;
      if (document.hidden) ms = Math.max(ms, 15000);
      if (inv.state === 'expired') ms = Math.max(ms, LATE_POLL_MS);   // after expiry: slower, only to flag a late payment
      inv.pollT = setTimeout(loop, ms);
    };
    loop();
  };
  /** v1.2.0: an invoice is watched while payable, and after expiry for LATE_WATCH_MS more (even if a new invoice was started),
   *  so a payment that arrives too late is flagged to the shop (kallubi:late) instead of being silently ignored. */
  Widget.prototype.watching = function (inv) {
    if (inv.state === 'waiting') return this.inv === inv;
    return inv.state === 'expired' && Date.now() < inv.deadline + LATE_WATCH_MS;
  };
  /** a watcher found a matching tx for `inv`. Before the deadline: normal flow. At/after the deadline: flagged as late. */
  Widget.prototype.found = function (inv, m) {
    if (this.claimed && this.claimed[m.txid]) return;          // a tx counts for one invoice only
    if (this.used[m.txid]) return;                              // ... and on one button of the page only
    if (inv.state === 'waiting' && this.inv === inv && Date.now() < inv.deadline) { this.claim(m.txid); return this.onMatch(m); }
    if (inv.state === 'waiting' && this.inv === inv) this.expire(inv);
    if (inv.state === 'expired' && Date.now() < inv.deadline + LATE_WATCH_MS) {
      // the tx would also pay the invoice that is open right now -> it belongs to that one (the buyer sees "paid", not "late")
      var cur = this.inv;
      if (cur !== inv && cur && cur.state === 'waiting' && Date.now() < cur.deadline && Number(m.sats) >= cur.sats) return this.found(cur, m);
      this.claim(m.txid); return this.onLate(inv, m);
    }
  };
  Widget.prototype.claim = function (txid) { (this.claimed = this.claimed || {})[txid] = 1; };
  Widget.prototype.onLate = function (inv, m) {
    inv.state = 'late'; inv.late = m; inv.lateAt = Date.now();
    if (!m.test) this.used[m.txid] = 1;                          // a late tx can never pay another invoice on this page
    clearInterval(inv.tick); clearTimeout(inv.pollT); clearTimeout(inv.testT); clearTimeout(inv.confT);
    var d = this.detail(m, inv); d.late = true; d.expiredAt = Math.floor(inv.deadline / 1000);
    if (this.inv === inv && this.modal) {
      var v = this.modal.dlg ? this.modal.dlg.getAttribute('data-view') : '';
      if (v === 'expired' || v === 'waiting') this.showModal('late');
    }
    this.emit('kallubi:late', d);
  };
  Widget.prototype.stopWatch = function () {
    var inv = this.inv; if (!inv || inv.state === 'expired') return;   // an expired invoice keeps its late-payment watch
    clearInterval(inv.tick); clearTimeout(inv.pollT); clearTimeout(inv.testT); clearTimeout(inv.confT);
  };
  Widget.prototype.tick = function () {
    var inv = this.inv; if (!inv) return;
    if (inv.state === 'seen') {
      if (this.timerEl) { var e = Math.floor((Date.now() - inv.seenAt) / 1000); this.timerEl.textContent = (e / 60 | 0) + ':' + ('0' + (e % 60)).slice(-2); }
      return;
    }
    if (inv.state !== 'waiting') return;
    var left = Math.max(0, inv.deadline - Date.now());
    if (this.timerEl) {
      var s = Math.ceil(left / 1000); this.timerEl.textContent = (s / 60 | 0) + ':' + ('0' + (s % 60)).slice(-2);
      if (this.barEl) this.barEl.style.width = (100 * left / (this.cfg.ttl * 1000)).toFixed(2) + '%';
    }
    if (left <= 0) this.expire(inv);
  };
  /** v1.2.0: the QR is withdrawn, but the watcher keeps running (slower) for LATE_WATCH_MS to flag a late payment */
  Widget.prototype.expire = function (inv) {
    if (inv.state !== 'waiting') return;
    inv.state = 'expired'; clearInterval(inv.tick);
    this.emit('kallubi:expired', this.detail({ txid: null, sats: 0, confirmations: 0 }, inv, true));
    var v = this.modal && this.modal.dlg ? this.modal.dlg.getAttribute('data-view') : '';
    if (this.inv === inv && this.modal && v !== 'quoting' && v !== 'rate' && v !== 'shipping') this.showModal('expired');
  };

  /** Test mode is offline (no rate fetch, no Broadcaster). Honour always-wait and any threshold we can evaluate; without a rate, accept 0-conf. */
  function testModeWait(c, inv) {
    if (c.confirmAboveFiat === 0) return true;
    var lim = zeroConfLimits(c, inv);
    if (lim.explicitBsv) return needsBlockConf(c, inv);
    if (lim.rateOk) return needsBlockConf(c, inv);
    return false;
  }
  /** True when this invoice cannot be accepted at 0-conf even with a passed quick check (above the EUR line, no rate, or always wait). */
  Widget.prototype.needsConfirmation = function (inv) {
    var c = this.cfg, i = inv || this.inv;
    if (c.test) return testModeWait(c, i);
    return needsBlockConf(c, i);
  };
  Widget.prototype.confInfoText = function (inv) {
    var c = this.cfg, t = this.t.bind(this), lim = zeroConfLimits(c, inv || this.inv);
    if (!lim.rateOk) return t('confInfoRate');
    if (c.fiat) return t('confInfoFiat', { a: fmtFiat(lim.applied, c.fiat.cur, c.lang) });
    if (lim.explicitBsv) return t('confInfo', { a: fmtBsv(c.confirmAbove) });
    return t('confInfoFiat', { a: fmtFiat(c.confirmAboveFiat, 'EUR', c.lang) });
  };
  /** Event detail. UX only: a shop must never ship on this alone, it can be forged by anyone who controls the browser.
   *  v1.2.0 adds orderId (shop's data-order-id or a random kp-… reference), expiresAt, and fiat (only with data-amount-fiat). */
  Widget.prototype.detail = function (m, inv, noTx) {
    inv = inv || this.inv; var c = this.cfg, n = Number(m.confirmations) || 0, q = inv.quote;
    var d = dropUndef({ txid: m.txid, amount: noTx ? undefined : fmtBsv(m.sats), sats: noTx ? undefined : m.sats, requestedSats: inv.sats, to: c.address, order: c.order || null, test: !!(m.test || (noTx && c.test)),
      confirmed: noTx ? undefined : n > 0, confirmations: noTx ? undefined : n, confirmationRequired: this.needsConfirmation(inv),
      confirmAboveSats: (function () { var lim = zeroConfLimits(c, inv); return lim.unit === 'sats' ? lim.applied : undefined; })(),
      confirmAboveFiat: (c.confirmAboveFiat / 100).toFixed(2),
      confirmAboveApplied: (function () { var lim = zeroConfLimits(c, inv); return lim.unit === 'cents' ? (lim.applied / 100).toFixed(2) : undefined; })(),
      quickCheck: inv.quickCheck || undefined,
      shipping: c.shipping ? shipCopy(this.ship) : undefined,
      orderId: inv.ref, orderIdGenerated: inv.refGenerated, tag: inv.offset, createdAt: inv.since, expiresAt: Math.floor(inv.deadline / 1000),
      fiat: q ? dropUndef({ amount: (c.fiat.cents / 100).toFixed(2), currency: c.fiat.cur, rate: String(q.rate), rateTime: q.ts, rateSource: q.source, quotedSats: q.sats,
        usdRate: q.usdRate == null ? undefined : String(q.usdRate), ecbRate: q.ecbRate == null ? undefined : String(q.ecbRate), ecbDate: q.ecbDate }) : undefined,
      serverVerify: 'required' });
    return d;
  };
  Widget.prototype.beginConfirmWait = function (m) {
    var inv = this.inv, self = this;
    inv.state = 'seen'; inv.seen = m; inv.seenAt = inv.seenAt || Date.now();
    if (!inv.tick) inv.tick = setInterval(function () { self.tick(); }, 1000);
    if (this.modal) this.showModal('confirming');
    this.render();
    if (!inv.seenEmitted) { inv.seenEmitted = 1; this.emit('kallubi:seen', this.detail(m), false); }
    this.watchConfirmation();
  };
  Widget.prototype.onMatch = function (m) {
    var inv = this.inv, self = this, c = this.cfg;
    if (this.used[m.txid]) return;
    if (!m.test) this.used[m.txid] = 1;
    this.deliverShipping(m);
    if ((Number(m.confirmations) || 0) >= 1) return this.onPaid(m);
    this.stopWatch();
    inv.seen = m; inv.seenAt = Date.now();
    var decide = function () {
      // Test mode stays offline (no Broadcaster, no rate fetch). It still honours "always wait" and an explicit
      // BSV threshold, and a fiat / converted threshold when a rate is already on the invoice.
      if (c.test) return testModeWait(c, inv) ? self.beginConfirmWait(m) : self.onPaid(m);
      if (self.needsConfirmation()) return self.beginConfirmWait(m);
      // A non-final transaction (nLockTime in the future with a non-final nSequence) can still be replaced: never 0-conf,
      // not even within the 20.00 EUR fallback. Checked on the verified raw tx (a height lock also reads the chain tip).
      if (!m.hex) return withinFallback(c, inv) ? self.onPaid(m) : self.beginConfirmWait(m);
      return finality({ node: c.node, fallback: c.fallback }, m.hex).then(function (fin) {
        if (self.inv !== inv || inv.state === 'paid') return;
        if (!fin.final) { inv.quickCheck = { ok: false, reason: 'not_final' }; return self.beginConfirmWait(m); }
        return decideFinal(fin.tip);
      });
    };
    var decideFinal = function (tip) {
      // Amounts within the 20.00 EUR fallback (or an explicit BSV threshold) stay on the previous instant 0-conf path.
      // Mid-range, up to the shop's EUR line, needs the quick check (own node + BSV Broadcaster).
      // If that check is unavailable, amounts above the fallback wait for 1 confirmation.
      if (withinFallback(c, inv)) return self.onPaid(m);
      var canQuick = !!(c.node && m.hex && m.source === 'node' && !m.test);
      if (!canQuick) return self.beginConfirmWait(m);
      inv.state = 'checking';
      if (!inv.tick) inv.tick = setInterval(function () { self.tick(); }, 1000);
      if (self.modal) self.showModal('checking');
      self.render();
      if (!inv.seenEmitted) { inv.seenEmitted = 1; self.emit('kallubi:seen', self.detail(m), false); }
      quickCheck({ hex: m.hex, txid: m.txid, node: c.node, fallback: c.fallback, roots: c.broadcasters, watchMs: c.quickMs, nowS: Math.floor(Date.now() / 1000), tipHeight: tip })
        .then(function (res) {
          if (self.inv !== inv || (inv.state !== 'checking' && inv.state !== 'seen')) return;
          inv.quickCheck = res;
          if (res && res.ok) return self.onPaid(m);
          if (res && res.hard) return self.beginConfirmWait(m);
          return withinFallback(c, inv) ? self.onPaid(m) : self.beginConfirmWait(m);
        }, function () {
          if (self.inv !== inv || (inv.state !== 'checking' && inv.state !== 'seen')) return;
          inv.quickCheck = { ok: false, reason: 'arc_unavailable' };
          return withinFallback(c, inv) ? self.onPaid(m) : self.beginConfirmWait(m);
        });
    };
    if (!c.test && !c.fiat && c.confirmAbove == null && !(inv.fx && inv.fx.eurMicro)) {
      var t0 = Date.now(), poll = function () {
        if (self.inv !== inv) return;
        if ((inv.fx && inv.fx.eurMicro) || Date.now() - t0 >= 2500) return decide();
        setTimeout(poll, 100);
      };
      return poll();
    }
    return decide();
  };

  Widget.prototype.watchConfirmation = function () {
    var self = this, inv = this.inv, c = this.cfg, m = inv.seen;
    if (c.test) { inv.confT = setTimeout(function () { if (self.inv === inv && inv.state === 'seen') self.onPaid({ txid: m.txid, sats: m.sats, confirmations: 1, test: true }); }, c.testConfirmDelay); return; }
    var every = Math.max(c.pollMs, Math.min(CONF_POLL_MS, c.pollMs * 3)), delay = every;
    // confirmations come from the node / fallback status; the worker list is only used when no chain source is configured
    var api = c.api && !c.node && !c.fallback ? new ApiWatcher({ address: c.address, sats: inv.sats, since: inv.since, api: c.api }) : null;
    if (api) api.baseline = {};
    var misses = 0;
    var check = function () {
      if (self.inv !== inv || inv.state !== 'seen') return;
      var p = api ? api.step().then(function () {
        var r = api.last || [];
        for (var i = 0; i < r.length; i++) if (r[i] && r[i].txid === m.txid) return { known: true, confirmations: Number(r[i].confirmations) || 0 };
        return { known: true, confirmations: 0 };
      }) : txStatus({ node: c.node, fallback: c.fallback, address: c.address }, m.txid);
      p.then(function (st) {
        if (self.inv !== inv || inv.state !== 'seen') return;
        delay = every;
        if (st.known || st.unreachable) misses = 0; else misses++;
        if (st.known && st.confirmations >= 1) return self.onPaid({ txid: m.txid, sats: m.sats, confirmations: st.confirmations });
        if (misses >= DROP_CHECKS && Date.now() - inv.seenAt >= DROP_MIN_MS) return self.onDropped(m);
        next(delay);
      }, function () { delay = Math.min(POLL_MAX_MS * 2, delay * 2); next(delay); });
    };
    var next = function (ms) {
      if (self.inv !== inv || inv.state !== 'seen' || Date.now() - inv.seenAt > CONF_MAX_MS) return;
      if (document.hidden) ms = Math.max(ms, 30000);
      inv.confT = setTimeout(check, ms);
    };
    next(every);
  };
  /** the seen tx vanished everywhere (double spend, replaced, evicted): no 'paid', tell page + buyer */
  Widget.prototype.onDropped = function (m) {
    var inv = this.inv;
    inv.state = 'dropped'; this.stopWatch();
    delete this.used[m.txid];
    this.render();
    if (this.modal) this.showModal('dropped');
    this.emit('kallubi:dropped', this.detail(m));
  };
  Widget.prototype.emit = function (name, detail) {
    try { this.node.dispatchEvent(new CustomEvent(name, { detail: detail, bubbles: true, composed: true })); } catch (e) {}
  };
  Widget.prototype.onPaid = function (m) {
    var inv = this.inv, c = this.cfg;
    var detail = this.detail(m);
    inv.state = 'paid'; this.stopWatch();
    this.paid = { txid: m.txid, sats: m.sats, confirmations: detail.confirmations, test: !!m.test };
    this.render();
    this.showModal('paid');
    this.emit('kallubi:paid', detail);
    if (c.onPaid && /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/.test(c.onPaid)) {
      var fn = c.onPaid.split('.').reduce(function (o, k) { return o && Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined; }, window);
      if (typeof fn === 'function') { try { fn.call(this.node, detail); } catch (e) { if (window.console) console.error(e); } }
    }
  };

  /* ------------------------------------------------------------------ v1.0.0 shipping address (data-shipping="1")
   *  Privacy: the address lives only in this page's memory (no cookies, no localStorage, no sessionStorage).
   *  It goes ONLY to the merchant: (a) in the kallubi:shipping / kallubi:seen / kallubi:paid events on the merchant's own page,
   *  (b) optionally POSTed by the buyer's browser straight to the merchant's data-shipping-url, (c) optionally as a mailto: draft
   *  to data-shipping-email that the buyer sends from their own mail app. Never to Kallubi, never to WhatsOnChain. */
  var SHIP_FIELDS = [['name', 'fName', 'name', 100, 1], ['street', 'fStreet', 'street-address', 120, 1], ['postalCode', 'fZip', 'postal-code', 20, 1],
    ['city', 'fCity', 'address-level2', 80, 1], ['country', 'fCountry', 'country-name', 60, 1], ['email', 'fEmail', 'email', 120, 0], ['note', 'fNote', '', 300, 0]];
  function shipCopy(s) { if (!s) return null; var o = {}; SHIP_FIELDS.forEach(function (f) { o[f[0]] = s[f[0]] || ''; }); return o; }
  function dropUndef(o) { for (var k in o) if (o[k] === undefined) delete o[k]; return o; }
  function bareLabel(s) { return String(s).replace(/\s*\([^)]*\)\s*$/, ''); }
  Widget.prototype.shipDetail = function () {
    var c = this.cfg, inv = this.inv;
    return { shipping: shipCopy(this.ship), order: c.order || null, label: c.label || null, merchant: c.merchant || null,
      requestedSats: inv ? inv.sats : null, tag: inv ? inv.offset : null, to: c.address, test: c.test,
      orderId: inv ? inv.ref : null, expiresAt: inv ? Math.floor(inv.deadline / 1000) : null };
  };
  Widget.prototype.submitShipping = function (vals) {
    this.ship = vals;
    if (this.live()) { this.emit('kallubi:shipping', this.shipDetail()); this.showModal('waiting'); return; }
    // fiat: the invoice (and with it the order reference + amount) only exists after the quote, so the event follows it
    var self = this;
    this.startInvoice(function () { self.emit('kallubi:shipping', self.shipDetail()); });
  };
  /** first match of an invoice: POST the address + payment facts to the merchant's own URL (if configured), once. */
  Widget.prototype.deliverShipping = function (m) {
    var self = this, c = this.cfg, inv = this.inv;
    if (!c.shipping || !this.ship || !inv || inv.ship) return;
    inv.ship = { state: c.shipUrl ? 'sending' : 'none' };
    if (!c.shipUrl) return;
    var n = Number(m.confirmations) || 0;
    var payload = { kallubi: 'shipping', version: VERSION, txid: m.txid, amount: fmtBsv(m.sats), sats: m.sats, requestedSats: inv.sats, tag: inv.offset,
      to: c.address, order: c.order || null, label: c.label || null, merchant: c.merchant || null, test: !!m.test, confirmed: n > 0, confirmations: n,
      shipping: shipCopy(this.ship), orderId: inv.ref, createdAt: inv.since, expiresAt: Math.floor(inv.deadline / 1000), serverVerify: 'required' };
    var ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var to = ctl ? setTimeout(function () { ctl.abort(); }, 15000) : 0;
    var done = function (ok, status) {
      clearTimeout(to); inv.ship.state = ok ? 'sent' : 'failed'; inv.ship.status = status;
      self.emit('kallubi:shipping-sent', { ok: ok, status: status, txid: m.txid, order: c.order || null, test: !!m.test });
      var v = self.modal && self.inv === inv && self.modal.dlg ? self.modal.dlg.getAttribute('data-view') : '';
      if (v === 'paid' || v === 'confirming' || v === 'checking') self.showModal(v);
    };
    try {
      // credentials omitted, no referrer, redirects refused: the data can only reach exactly this URL
      fetch(c.shipUrl, { method: 'POST', mode: 'cors', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer', redirect: 'error',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: ctl ? ctl.signal : undefined })
        .then(function (r) { done(!!r.ok, r.status); }, function () { done(false, 0); });
    } catch (e) { done(false, 0); }
  };
  Widget.prototype.mailtoHref = function (txid, sats, test) {
    var c = this.cfg, s = this.ship, t = this.t.bind(this);
    var ref = c.order ? '#' + c.order.replace(/^#/, '') : (c.label || String(txid).slice(0, 8));
    var L = [t('mailHello'), '', bareLabel(t('fName')) + ': ' + s.name, bareLabel(t('fStreet')) + ': ' + s.street, bareLabel(t('fZip')) + ': ' + s.postalCode,
      bareLabel(t('fCity')) + ': ' + s.city, bareLabel(t('fCountry')) + ': ' + s.country];
    if (s.email) L.push(bareLabel(t('fEmail')) + ': ' + s.email);
    if (s.note) L.push(bareLabel(t('fNote')) + ': ' + s.note);
    L.push('');
    if (c.order) L.push(t('order', { o: c.order.replace(/^#/, '') }));
    if (c.label) L.push(c.label);
    L.push(t('amount') + ': ' + fmtBsv(sats) + ' BSV', t('tx') + ': ' + txid);
    if (test) L.push('', t('testNoTx'));
    return 'mailto:' + c.shipMail + '?subject=' + encodeURIComponent(t('mailSubj', { o: ref })) + '&body=' + encodeURIComponent(L.join('\r\n'));
  };
  /** status block in the confirming / paid view */
  Widget.prototype.shipBox = function (txid, sats, test) {
    var c = this.cfg, inv = this.inv, t = this.t.bind(this);
    if (!c.shipping || !this.ship) return null;
    var st = inv && inv.ship ? inv.ship.state : 'none', kids = [];
    if (st === 'sending') kids.push(el('div', { class: 'shs' }, [el('div', { class: 'spin' }), el('span', { text: t('shipSending') })]));
    else if (st === 'sent') kids.push(el('div', { class: 'shs good', text: t('shipSent') }));
    else if (st === 'failed') kids.push(el('div', { class: 'shs bad', text: t('shipFail') }));
    if (c.shipMail && (st === 'none' || st === 'failed')) {
      kids.push(el('a', { class: 'btn outline', href: this.mailtoHref(txid, sats, test), 'data-mailto': '' }, [t('shipMail')]));
      kids.push(el('div', { class: 'note', text: t('shipMailHint') }));
    } else if (st === 'failed') kids.push(el('div', { class: 'note', text: t('shipKeep') }));
    return kids.length ? el('div', { class: 'shipbox', role: 'status', 'aria-live': 'polite' }, kids) : null;
  };
  function shipSummary(s) { return [s.name, [s.postalCode, s.city].filter(Boolean).join(' '), s.country].filter(Boolean).join(', '); }
  Widget.prototype.viewShipping = function () {
    var self = this, c = this.cfg, t = this.t.bind(this), v = this.ship || {};
    this.timerEl = this.barEl = null;
    var inputs = {}, errEls = {};
    var field = function (f) {
      var id = 'kp-f-' + f[0];
      var a = { class: 'in', id: id, name: f[0], maxlength: String(f[3]), 'aria-describedby': id + '-e', 'aria-required': f[4] ? 'true' : null,
        autocomplete: f[0] === 'email' ? 'email' : f[2] ? 'shipping ' + f[2] : 'off', spellcheck: f[0] === 'note' ? null : 'false' };
      var inp = f[0] === 'note' ? el('textarea', Object.assign(a, { rows: '2' })) : el('input', Object.assign(a, { type: f[0] === 'email' ? 'email' : 'text', inputmode: f[0] === 'email' ? 'email' : null }));
      inp.value = v[f[0]] || '';
      inp.addEventListener('input', function () { if (inp.getAttribute('aria-invalid') === 'true') { inp.removeAttribute('aria-invalid'); errEls[f[0]].textContent = ''; } });
      inputs[f[0]] = inp; errEls[f[0]] = el('div', { class: 'fe', id: id + '-e' });
      return el('div', { class: 'fld' }, [el('label', { for: id, text: t(f[1]) }), inp, errEls[f[0]]]);
    };
    var F = {}; SHIP_FIELDS.forEach(function (f) { F[f[0]] = field(f); });
    var ferr = el('div', { class: 'ferr', role: 'alert' });
    var submit = el('button', { type: 'submit', class: 'btn gold', 'data-focus': '' }, [t('toPay')]);
    var priv = el('div', { class: 'priv' }, [(c.merchant ? t('shipNoteM', { m: c.merchant }) : t('shipNote')) + (c.shipHost ? ' ' + t('shipVia', { h: c.shipHost }) : '')]);
    var form = el('form', { class: 'sf', novalidate: '', autocomplete: 'on', 'aria-labelledby': 'kp-ship-h' }, [
      c.test ? el('div', { class: 'amt' }, [el('div', { class: 'testnote', role: 'note', text: t('testNote') })]) : null,
      el('div', { class: 'sh', id: 'kp-ship-h', text: t('shipH') }), el('div', { class: 'ssub', text: t('shipSub') }),
      el('div', { class: 'samt' }, [t('amount') + ': ', el('b', { text: c.fiat ? fmtFiat(c.fiat.cents, c.fiat.cur, c.lang) : fmtBsv(c.baseSats) + ' BSV' })]),
      F.name, F.street, el('div', { class: 'two' }, [F.postalCode, F.city]), F.country, F.email, F.note, priv, ferr, submit]);
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var vals = {}, bad = [];
      SHIP_FIELDS.forEach(function (f) {
        var val = clean(String(inputs[f[0]].value).replace(/[\r\n\t]+/g, ' '), f[3]), msg = '';
        if (f[4] && !val) msg = t('req');
        else if (f[0] === 'email' && val && !isEmail(val)) msg = t('badEmail');
        errEls[f[0]].textContent = msg;
        if (msg) { inputs[f[0]].setAttribute('aria-invalid', 'true'); bad.push(f[0]); } else inputs[f[0]].removeAttribute('aria-invalid');
        vals[f[0]] = val;
      });
      if (bad.length) { ferr.textContent = t('fixErr'); try { inputs[bad[0]].focus(); } catch (x) {} return; }
      ferr.textContent = '';
      self.submitShipping(vals);
    });
    return el('div', { class: 'mbody' }, [form]);
  };

  Widget.prototype.close = function () {
    if (!this.modal) return;
    document.removeEventListener('keydown', this.modal.onKey, true);
    if (this.modal.host.parentNode) this.modal.host.parentNode.removeChild(this.modal.host);
    if (this.modal.prevFocus && this.modal.prevFocus.focus) try { this.modal.prevFocus.focus(); } catch (e) {}
    this.modal = null; this.timerEl = this.barEl = null;
    // note: the watcher keeps running in the background until the window expires,
    // so a buyer who pays and closes the dialog is still detected.
  };

  Widget.prototype.showModal = function (view) {
    var self = this, c = this.cfg;
    if (!this.modal) {
      var host = el('div', { class: 'kp-modal-host', 'data-kallubi-modal': '' });
      host.className = 'kp-modal-host';
      var sr = host.attachShadow({ mode: 'open' });
      var onKey = function (e) { if (e.key === 'Escape') { e.stopPropagation(); self.close(); } else if (e.key === 'Tab') self.trap(e); };
      this.modal = { host: host, sr: sr, onKey: onKey, prevFocus: document.activeElement };
      document.addEventListener('keydown', onKey, true);
      document.body.appendChild(host);
    }
    var sr2 = this.modal.sr; sr2.textContent = ''; addStyle(sr2);
    var title = c.merchant ? this.t('titleM', { m: c.merchant }) : this.t('title');
    var sub = [c.order ? this.t('order', { o: c.order.replace(/^#/, '') }) : '', c.label].filter(Boolean).join(' \u00b7 ') || 'Kallubi Pay';
    var xBtn = el('button', { type: 'button', class: 'x', 'aria-label': this.t('close'), text: '\u2715' });
    xBtn.addEventListener('click', function () { self.close(); });
    var head = el('div', { class: 'mhead' }, [logo(30), el('div', { class: 'mt' }, [el('div', { class: 't', id: 'kp-title', text: title }), el('div', { class: 's', text: sub })]), xBtn]);
    var body = view === 'paid' ? this.viewPaid() : view === 'expired' ? this.viewExpired() : view === 'dropped' ? this.viewDropped() : (view === 'confirming' || view === 'checking') ? this.viewConfirming() : view === 'shipping' ? this.viewShipping()
      : view === 'quoting' ? this.viewQuoting() : view === 'rate' ? this.viewRate() : view === 'late' ? this.viewLate() : this.viewWaiting();
    if (view !== 'waiting' && view !== 'confirming') this.timerEl = this.barEl = null;
    var foot = el('div', { class: 'mfoot' }, [el('span', { text: this.t('foot') }),
      el('a', { href: KALLUBI_URL, target: '_blank', rel: 'noopener noreferrer', title: this.t('poweredBy') + ' Kallubi' }, [logo(14), 'Kallubi'])]);
    var dlg = el('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'kp-title', 'data-view': view, tabindex: '-1' }, [head, body, foot]);
    var ov = el('div', { class: this.themeClass() + ' ov', lang: c.lang }, [dlg]);
    ov.addEventListener('mousedown', function (e) { if (e.target === ov) self.close(); });
    sr2.appendChild(ov);
    this.modal.dlg = dlg;
    try { dlg.focus({ preventScroll: true }); } catch (e) {}
    if (view === 'waiting' || view === 'confirming' || view === 'checking') this.tick();
  };
  Widget.prototype.trap = function (e) {
    if (!this.modal) return;
    var f = Array.prototype.slice.call(this.modal.dlg.querySelectorAll('button,a[href],input,textarea')).filter(function (n) { return !n.disabled && n.getAttribute('aria-disabled') !== 'true'; });
    if (!f.length) return;
    var a = this.modal.sr.activeElement, i = f.indexOf(a);
    if (e.shiftKey && i <= 0) { e.preventDefault(); f[f.length - 1].focus(); }
    else if (!e.shiftKey && (i === f.length - 1 || i < 0)) { e.preventDefault(); f[0].focus(); }
  };

  Widget.prototype.viewWaiting = function () {
    var self = this, c = this.cfg, inv = this.inv, uri = this.uri(), t = this.t.bind(this);
    var amt = el('div', { class: 'amt' }, [
      c.test ? el('div', { class: 'testnote', role: 'note', text: t('testNote') }) : null,
      el('div', { class: 'k', text: t('amount') }),
      el('div', { class: 'v', 'data-amount': fmtBsv(inv.sats) }, [fmtBsv(inv.sats), el('small', { text: 'BSV' })]),
      el('div', { class: 'sats', text: '= ' + fmtSats(inv.sats, c.lang) + ' sats' }),
      inv.offset ? el('div', { class: 'tag', text: t('tag', { n: inv.offset }) }) : null,
      inv.quote ? el('div', { class: 'fiat', 'data-fiat': (c.fiat.cents / 100).toFixed(2) + ' ' + c.fiat.cur, text: t('fiatPrice', { f: fmtFiat(c.fiat.cents, c.fiat.cur, c.lang) }) }) : null,
      inv.quote ? el('div', { class: 'rate', 'data-rate': String(inv.quote.rate), 'data-rate-ts': String(inv.quote.ts),
        text: t('rateLine', { r: fmtRate(inv.quote.rate, c.fiat.cur, c.lang), t: fmtTime(inv.quote.ts, c.lang) }) + ' \u00b7 ' + t('rateFixed') }) : null,
      inv.quote ? el('div', { class: 'rate src', 'data-rate-source': inv.quote.source, text: t('rateSrc', { s: srcName(inv.quote) }) }) : null]);
    var ql = el('span', { class: 'ql' }, [logo(42)]);
    var qr = el('div', { class: 'qrwrap', 'data-uri': uri }, [qrSvg(uri, t('qr')), ql]);
    var copyLbl = el('span', { text: t('copy') });
    var copy = el('button', { type: 'button', class: 'copy', 'aria-label': t('copyAria') }, [icon(['M9 9h12v12H9z', 'M5 15V5a2 2 0 0 1 2-2h10'], 13), copyLbl]);
    copy.addEventListener('click', function () {
      copyText(c.address).then(function () { copyLbl.textContent = t('copied'); setTimeout(function () { copyLbl.textContent = t('copy'); }, 1800); },
        function () { copyLbl.textContent = t('copyFail'); });
    });
    var addr = el('div', { class: 'addr' }, [el('div', { class: 'grow' }, [el('div', { class: 'lbl', text: t('addr') }), el('div', { class: 'a', title: c.address, text: c.address })]), copy]);
    var open = el('a', { class: 'btn gold', href: uri, 'data-focus': '' }, [t('open')]);
    this.timerEl = el('div', { class: 'timer', 'aria-label': t('timeLeft') });
    this.barEl = el('i');
    var wait = el('div', { class: 'wait', role: 'status', 'aria-live': 'polite' }, [el('div', { class: 'spin' }),
      el('div', {}, [el('div', { class: 'w1', text: t('waiting') }), el('div', { class: 'w2', text: c.test ? t('testSoon') : t('auto') })]), this.timerEl]);
    var shiprow = null;
    if (c.shipping && this.ship) {
      var ed = el('button', { type: 'button', class: 'lnk', text: t('edit') });
      ed.addEventListener('click', function () { self.showModal('shipping'); });
      shiprow = el('div', { class: 'shiprow' }, [el('span', { text: t('shipTo') + ':' }), el('span', { class: 'sv', title: shipSummary(this.ship), text: shipSummary(this.ship) }), ed]);
    }
    return el('div', { class: 'mbody' }, [amt, qr, addr, open, wait, el('div', { class: 'bar' }, [this.barEl]), shiprow]);
  };
  Widget.prototype.viewPaid = function () {
    var self = this, c = this.cfg, p = this.paid, t = this.t.bind(this);
    var status = p.test ? t('testSim') + (p.confirmations > 0 ? ' \u00b7 ' + t('confs', { n: 1 }) : '') : (p.confirmations > 0 ? t('confirmed', { c: t('confs', { n: p.confirmations }) }) : t('seenNet'));
    var ex = el('a', { class: 'btn outline', href: p.test ? KALLUBI_URL : EXPLORER_TX + p.txid, target: '_blank', rel: 'noopener noreferrer', title: p.test ? t('testNoTx') : null }, [t('explorer')]);
    var back = el('button', { type: 'button', class: 'btn gold', 'data-focus': '', text: t('back') });
    back.addEventListener('click', function () { self.close(); });
    return el('div', { class: 'mbody' }, [el('div', { class: 'ok' }, [
      el('div', { class: 'check' }, [icon(['M5 12.5l4.5 4.5L19 7.5'], 50, '3.2')]),
      el('h2', {}, [t('received') + ' ', el('span', { text: '\u2713' })]),
      el('p', { text: c.merchant ? t('thanksM', { m: c.merchant }) : t('thanks') }),
      el('div', { class: 'rows' }, [
        el('div', { class: 'row' }, [el('span', { class: 'k', text: t('amount') }), el('span', { class: 'v' }, [fmtBsv(p.sats) + ' BSV ', el('span', { text: '\u00b7 ' + fmtSats(p.sats, c.lang) + ' sats' })])]),
        el('div', { class: 'row' }, [el('span', { class: 'k', text: t('paidTo') }), el('span', { class: 'mono', title: c.address, text: short(c.address, 8, 4) })]),
        el('div', { class: 'row' }, [el('span', { class: 'k', text: t('tx') }), el('span', { class: 'mono', 'data-txid': p.txid, title: p.txid, text: short(p.txid, 8, 8) })]),
        el('div', { class: 'row' }, [el('span', { class: 'k', text: t('status') }), el('span', { class: 'pill', text: status })]),
        c.shipping && this.ship ? el('div', { class: 'row' }, [el('span', { class: 'k', text: t('shipTo') }), el('span', { class: 'v', title: shipSummary(this.ship), text: this.ship.name + ', ' + this.ship.city })]) : null]),
      this.shipBox(p.txid, p.sats, p.test), ex, back])]);
  };
  Widget.prototype.viewConfirming = function () {
    var self = this, c = this.cfg, inv = this.inv, m = inv.seen, t = this.t.bind(this), checking = inv.state === 'checking';
    this.timerEl = el('div', { class: 'timer', 'aria-label': t('sinceSeen') });
    this.barEl = null;
    var wait = el('div', { class: 'wait seen', role: 'status', 'aria-live': 'polite' }, [el('div', { class: 'spin' }),
      el('div', {}, [el('div', { class: 'w1', text: checking ? t('checkWait') : t('seenWait') }),
        el('div', { class: 'w2', text: checking ? '' : (c.test ? t('testConf') : t('safe')) })]), this.timerEl]);
    var ex = el('a', { class: 'btn outline', href: m.test ? KALLUBI_URL : EXPLORER_TX + m.txid, target: '_blank', rel: 'noopener noreferrer', title: m.test ? t('testNoTx') : null }, [t('explorer')]);
    return el('div', { class: 'mbody' }, [el('div', { class: 'ok' }, [
      el('div', { class: 'check ring' }, [icon(['M5 12.5l4.5 4.5L19 7.5'], 50, '3.2')]),
      el('h2', {}, [checking ? t('checkH') : (t('seenH') + ' '), checking ? null : el('span', { text: '\u2713' })]),
      el('p', { text: checking ? t('checkInfo') : self.confInfoText(inv) }),
      wait,
      el('div', { class: 'rows' }, [
        el('div', { class: 'row' }, [el('span', { class: 'k', text: t('amount') }), el('span', { class: 'v' }, [fmtBsv(m.sats) + ' BSV ', el('span', { text: '\u00b7 ' + fmtSats(m.sats, c.lang) + ' sats' })])]),
        el('div', { class: 'row' }, [el('span', { class: 'k', text: t('tx') }), el('span', { class: 'mono', 'data-txid': m.txid, title: m.txid, text: short(m.txid, 8, 8) })]),
        el('div', { class: 'row' }, [el('span', { class: 'k', text: t('status') }), el('span', { class: 'pill', text: checking ? t('checkPill') : t('seenPill') })])]),
      this.shipBox(m.txid, m.sats, m.test), ex])]);
  };
  Widget.prototype.viewDropped = function () {
    var self = this, t = this.t.bind(this);
    var again = el('button', { type: 'button', class: 'btn gold', 'data-focus': '', text: t('again') });
    again.addEventListener('click', function () { self.newInvoice(); self.showModal('waiting'); });
    var back = el('button', { type: 'button', class: 'btn outline', text: t('back') });
    back.addEventListener('click', function () { self.close(); });
    return el('div', { class: 'mbody' }, [el('div', { class: 'ok' }, [
      el('div', { class: 'check dim' }, [icon(['M12 8v5', 'M12 16.5v.5', 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z'], 46, '2.6')]),
      el('h2', { text: t('dropH') }),
      el('p', { text: t('dropP') }),
      again, back])]);
  };
  Widget.prototype.viewExpired = function () {
    var self = this, t = this.t.bind(this);
    var again = el('button', { type: 'button', class: 'btn gold', 'data-focus': '', text: t('again') });
    again.addEventListener('click', function () { self.startInvoice(); });
    var back = el('button', { type: 'button', class: 'btn outline', text: t('back') });
    back.addEventListener('click', function () { self.close(); });
    return el('div', { class: 'mbody' }, [el('div', { class: 'ok' }, [
      el('div', { class: 'check dim' }, [icon(['M12 7v5l3 2', 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z'], 46, '2.6')]),
      el('h2', { text: t('expH') }),
      el('p', { text: t('expP') }),
      again, back])]);
  };

  /* v1.2.0 views: rate loading, rate unavailable (no QR), late payment */
  Widget.prototype.viewQuoting = function () {
    var t = this.t.bind(this);
    return el('div', { class: 'mbody' }, [el('div', { class: 'wait', role: 'status', 'aria-live': 'polite' }, [el('div', { class: 'spin' }),
      el('div', {}, [el('div', { class: 'w1', text: t('quoting') }), el('div', { class: 'w2', text: fmtFiat(this.cfg.fiat.cents, this.cfg.fiat.cur, this.cfg.lang) })])])]);
  };
  Widget.prototype.viewRate = function () {
    var self = this, t = this.t.bind(this);
    var again = el('button', { type: 'button', class: 'btn gold', 'data-focus': '', text: t('again') });
    again.addEventListener('click', function () { self.startInvoice(); });
    var back = el('button', { type: 'button', class: 'btn outline', text: t('back') });
    back.addEventListener('click', function () { self.close(); });
    return el('div', { class: 'mbody' }, [el('div', { class: 'ok', role: 'alert' }, [
      el('div', { class: 'check dim' }, [icon(['M12 8v5', 'M12 16.5v.01', 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z'], 46, '2.6')]),
      el('h2', { text: t('rateH') }), el('p', { text: t('rateP') }), again, back])]);
  };
  Widget.prototype.viewLate = function () {
    var self = this, c = this.cfg, inv = this.inv, m = inv.late, t = this.t.bind(this);
    var ex = el('a', { class: 'btn outline', href: m.test ? KALLUBI_URL : EXPLORER_TX + m.txid, target: '_blank', rel: 'noopener noreferrer', title: m.test ? t('testNoTx') : null }, [t('explorer')]);
    var back = el('button', { type: 'button', class: 'btn gold', 'data-focus': '', text: t('back') });
    back.addEventListener('click', function () { self.close(); });
    return el('div', { class: 'mbody' }, [el('div', { class: 'ok' }, [
      el('div', { class: 'check dim' }, [icon(['M12 7v5l3 2', 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z'], 46, '2.6')]),
      el('h2', { text: t('lateH') }), el('p', { text: t('lateP') }),
      el('div', { class: 'rows' }, [
        el('div', { class: 'row' }, [el('span', { class: 'k', text: t('amount') }), el('span', { class: 'v' }, [fmtBsv(m.sats) + ' BSV ', el('span', { text: '\u00b7 ' + fmtSats(m.sats, c.lang) + ' sats' })])]),
        el('div', { class: 'row' }, [el('span', { class: 'k', text: t('tx') }), el('span', { class: 'mono', 'data-txid': m.txid, title: m.txid, text: short(m.txid, 8, 8) })]),
        el('div', { class: 'row' }, [el('span', { class: 'k', text: t('status') }), el('span', { class: 'pill late', text: t('latePill') })])]),
      back, ex])]);
  };

  function copyText(t) {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(t);
    return new Promise(function (res, rej) {
      var ta = el('textarea', { readonly: '' }); ta.style.position = 'fixed'; ta.style.top = '-1000px'; ta.style.opacity = '0'; ta.value = t;
      document.body.appendChild(ta); ta.select();
      var ok = false; try { ok = document.execCommand('copy'); } catch (e) {}
      document.body.removeChild(ta); ok ? res() : rej(new Error('copy'));
    });
  }

  /* ------------------------------------------------------------------ mount */
  var mounted = typeof WeakMap !== 'undefined' ? new WeakMap() : null;
  function mount(node) {
    if (!node || node.nodeType !== 1 || (mounted && mounted.has(node))) return mounted && mounted.get(node);
    var w = new Widget(node); if (mounted) mounted.set(node, w); return w;
  }
  function scan(root) { Array.prototype.forEach.call((root || document).querySelectorAll('[data-kallubi-pay]'), mount); }
  function start() {
    scan();
    if (typeof MutationObserver !== 'undefined') new MutationObserver(function (ms) {
      ms.forEach(function (m) { Array.prototype.forEach.call(m.addedNodes, function (n) {
        if (n.nodeType !== 1) return; if (n.hasAttribute('data-kallubi-pay')) mount(n); else if (n.querySelector) scan(n); }); });
    }).observe(document.documentElement, { childList: true, subtree: true });
  }

  window.KallubiPay = {
    version: VERSION, mount: mount, scan: scan,
    // exposed for tests / advanced use (pure functions, no side effects)
    languages: LANGS.slice(),
    util: { pickLang: pickLang, normLang: normLang, t: tr, strings: function (l) { var o = {}, k, tab = I18N[normLang(l) || 'en']; for (k in tab) o[k] = tab[k]; return o; }, inspectAddress: inspectAddress, addressScript: addressScript, addressError: addressError, isEmail: isEmail, shipUrlHost: shipUrlHost, parseAmount: parseAmount, amountError: amountError, parseThreshold: parseThreshold, fmtBsv: fmtBsv, matchTx: matchTx, Watcher: Watcher, verifiedSats: verifiedSats, txOutputs: function (hex) { return txOutputs(hexBytes(hex)); }, txidOf: function (hex) { var b = hexBytes(hex); return b ? txidOf(b) : null; }, parseFiat: parseFiat, parseOrderId: parseOrderId, rateMicro: rateMicro, fiatToSats: fiatToSats, checkRate: checkRate, fmtFiat: fmtFiat, genRef: genRef, parseEcbCsv: parseEcbCsv, checkEcb: checkEcb, parseTx: function (hex) { var b = hexBytes(hex); if (!b) return null; try { var t = parseTx(b); return { version: t.version, inputs: t.inputs.map(function (x) { return { prevTxid: x.prevTxid, vout: x.vout, sequence: x.sequence }; }), outputs: t.outputs.map(function (x) { return { value: x.value, script: toHex(x.script) }; }), locktime: t.locktime, size: t.size }; } catch (e) { return null; } }, isTxFinal: isTxFinal, feeSufficient: feeSufficient, eurToUsdCents: eurToUsdCents, eurToSatsFloor: eurToSatsFloor, zeroConfLimits: zeroConfLimits, needsBlockConf: needsBlockConf, withinFallback: withinFallback, toEf: toEf, sha256hex: function (u8) { return toHex(sha256(u8)); } }
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
