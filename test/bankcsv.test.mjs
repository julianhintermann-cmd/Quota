// Bank-Import: der CSV-Leser aus public/js/bankcsv.js mit typischen Exporten verschiedener Banken
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const ctx = { TextDecoder };
ctx.self = ctx;
vm.runInNewContext(readFileSync(new URL('../public/js/bankcsv.js', import.meta.url), 'utf8'), ctx);
const B = ctx.BankCSV;
const run = csv => { const p = B.read(csv); return { ...p, ...B.extract(p) }; };
const plain = v => JSON.parse(JSON.stringify(v));

test('Beträge und Daten in allen üblichen Schreibweisen', () => {
  const cases = [['1\'234.50', 1234.5], ['1’234.50', 1234.5], ['1.234,50', 1234.5], ['-12.50', -12.5], ['12.50-', -12.5], ['(12.50)', -12.5],
    ['−7,20', -7.2], ['CHF 45.00', 45], ['1,234.50', 1234.5], ['12,5', 12.5], ['1,000', 1000], ['="-3.10"', -3.1], ['', null], ['abc', null], ['+8', 8], ['12.50 €', 12.5], ['9930031TO1234567', null]];
  for (const [s, v] of cases) assert.equal(B.parseAmount(s), v, s);
  const dates = [['31.01.2024', '2024-01-31'], ['1.2.24', '2024-02-01'], ['2024-01-31', '2024-01-31'], ['2024-01-31 14:05:00', '2024-01-31'],
    ['2024-01-31T10:00:00Z', '2024-01-31'], ['31/01/2024', '2024-01-31'], ['31-01-2024', '2024-01-31'], ['="2024-03-05"', '2024-03-05'],
    ['31.02.2024', null], ['Saldo', null], ['', null]];
  for (const [s, v] of dates) assert.equal(B.parseDate(s), v, s);
});

test('Kodierung und Trennzeichen', () => {
  const win = Uint8Array.from([0x44, 0x61, 0x74, 0x75, 0x6d, 0x3b, 0x42, 0x65, 0x74, 0x72, 0x61, 0x67, 0x3b, 0x54, 0x65, 0x78, 0x74, 0x0a,
    0x30, 0x31, 0x2e, 0x30, 0x32, 0x2e, 0x32, 0x30, 0x32, 0x34, 0x3b, 0x2d, 0x35, 0x3b, 0x5a, 0xfc, 0x72, 0x69, 0x63, 0x68]); // "Zürich" in Windows-1252
  const r = run(win);
  assert.equal(r.items[0].text, 'Zürich');
  assert.equal(B.detectDelimiter('a,b,c\n1,2,3'), ',');
  assert.equal(B.detectDelimiter('a;b;c\n"1,5";2;3'), ';');
  assert.equal(B.detectDelimiter('a\tb\tc\n1\t2\t3'), '\t');
  const bom = new TextEncoder().encode('﻿Date,Amount,Description\n2024-02-01,-9.90,Netflix');
  assert.equal(run(bom).items[0].text, 'Netflix');
});

test('UBS (neues E-Banking)', () => {
  const csv = `Kontonummer:;0235 00123456.40;
IBAN:;CH12 0023 5235 1234 5678 9;
Von:;2024-01-01;
Bis:;2024-01-31;
Anfangssaldo:;1000.00;
Schlusssaldo:;850.00;
Bewertet in:;CHF;
Anzahl Transaktionen in diesem Zeitraum:;3;

Abschlussdatum;Abschlusszeit;Buchungsdatum;Valutadatum;Währung;Belastung;Gutschrift;Einzelbetrag;Saldo;Transaktions-Nr.;Beschreibung1;Beschreibung2;Beschreibung3;Fussnoten
2024-01-30;;2024-01-31;2024-01-31;CHF;-58.40;;;850.00;9930031TO1234567;Coop-1234 Zuerich;Zahlung Debitkarte;Kartennummer: 1234 56XX XXXX 1234;
2024-01-25;;2024-01-25;2024-01-25;CHF;;5400.00;;908.40;9930025TO7654321;Arbeitgeber AG;Lohn Januar;;
2024-01-20;;2024-01-22;2024-01-22;CHF;-1'650.00;;;-4491.60;9930020TO1111111;Immo Verwaltung GmbH;Dauerauftrag;;
`;
  const r = run(csv);
  assert.equal(r.bank, 'UBS');
  assert.deepEqual(plain(r.items.map(i => [i.date, i.amount, i.text, i.currency])), [
    ['2024-01-30', 58.4, 'Coop-1234 Zuerich', 'CHF'],
    ['2024-01-20', 1650, 'Immo Verwaltung GmbH', 'CHF'],
  ]);
  assert.equal(r.stats.income, 1);
});

test('PostFinance', () => {
  const csv = `Datum von:;="2024-01-01"
Datum bis:;="2024-01-31"
Konto:;="CH1234567890"
Währung:;="CHF"

Buchungsdatum;Avisierungstext;Gutschrift in CHF;Lastschrift in CHF;Label;Kategorie
31.01.2024;"KAUF/DIENSTLEISTUNG VOM 29.01.2024 KARTEN NR. XXXX1234 MIGROS M ZUERICH";;-45.30;;Lebensmittel
30.01.2024;"TWINT KAUF/DIENSTLEISTUNG VOM 30.01.2024 SBB CFF FFS";;-12.40;;Verkehr
25.01.2024;"GUTSCHRIFT VON ARBEITGEBER AG";5400.00;;;
`;
  const r = run(csv);
  assert.equal(r.bank, 'PostFinance');
  assert.deepEqual(plain(r.items.map(i => [i.date, i.amount, i.text])), [
    ['2024-01-30', 12.4, 'SBB CFF FFS'],
    ['2024-01-29', 45.3, 'Migros M Zuerich'],
  ]);
});

test('Raiffeisen', () => {
  const csv = `IBAN;Booked At;Text;Credit/Debit Amount;Balance;Valuta Date
CH1234;2024-01-31 00:00:00.0;Einkauf Visa Debit Card Nr. xxxx 1234, Denner Basel;-38.65;1200.5;2024-01-31 00:00:00.0
CH1234;2024-01-29 00:00:00.0;Gutschrift Lohn;5400;1239.15;2024-01-29 00:00:00.0
`;
  const r = run(csv);
  assert.equal(r.bank, 'Raiffeisen');
  assert.deepEqual(plain(r.items.map(i => [i.date, i.amount, i.text])), [['2024-01-31', 38.65, 'Denner Basel']]);
});

test('ZKB mit Belastung/Gutschrift und Detailzeilen', () => {
  const csv = `"Datum";"Buchungstext";"Whg";"Betrag Detail";"ZKB-Referenz";"Referenznummer";"Belastung CHF";"Gutschrift CHF";"Valuta";"Saldo CHF";"Zahlungszweck"
"31.01.2024";"Einkauf ZKB Visa Debit Card Nr. xxxx 1234, Migros Zürich";"CHF";"";"Z1234";"";"23.80";"";"31.01.2024";"950.00";""
"30.01.2024";"Sammelauftrag";"CHF";"";"Z1235";"";"400.00";"";"30.01.2024";"973.80";""
"";"Krankenkasse";"CHF";"385.40";"";"";"";"";"";"";""
"25.01.2024";"Gutschrift";"CHF";"";"Z1236";"";"";"5'400.00";"25.01.2024";"1373.80";"Lohn"
`;
  const r = run(csv);
  assert.equal(r.bank, 'Zürcher Kantonalbank');
  assert.deepEqual(plain(r.items.map(i => [i.date, i.amount, i.text])), [['2024-01-31', 23.8, 'Migros Zürich'], ['2024-01-30', 400, 'Sammelauftrag']]);
});

test('Revolut (englisch und deutsch), nur abgeschlossene Käufe', () => {
  const en = `Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance
CARD_PAYMENT,Current,2024-01-30 12:01:05,2024-01-31 08:00:00,Starbucks,-6.50,0.00,CHF,COMPLETED,93.50
CARD_PAYMENT,Current,2024-01-30 18:00:00,,Uber,-18.20,0.00,CHF,PENDING,93.50
CARD_PAYMENT,Current,2024-01-29 10:00:00,2024-01-29 10:00:00,Amazon,-30.00,0.00,CHF,REVERTED,
EXCHANGE,Current,2024-01-28 10:00:00,2024-01-28 10:00:00,Exchanged to EUR,-100.00,0.00,CHF,COMPLETED,100.00
TOPUP,Current,2024-01-27 10:00:00,2024-01-27 10:00:00,Top-Up by *1234,200.00,0.00,CHF,COMPLETED,200.00
`;
  const r = run(en);
  assert.equal(r.bank, 'Revolut');
  assert.deepEqual(plain(r.items.map(i => [i.date, i.amount, i.text, i.pending])), [['2024-01-30', 6.5, 'Starbucks', false], ['2024-01-30', 18.2, 'Uber', true]]);
  const de = `Art,Produkt,Startdatum,Datum des Abschlusses,Beschreibung,Betrag,Gebühr,Währung,Status,Saldo
KARTENZAHLUNG,Aktuell,2024-02-02 09:00:00,2024-02-02 09:10:00,Coop Pronto,"-12,90",0,EUR,ABGESCHLOSSEN,87
`;
  const d = run(de);
  assert.equal(d.bank, 'Revolut');
  assert.deepEqual(plain(d.items.map(i => [i.date, i.amount, i.text, i.currency])), [['2024-02-02', 12.9, 'Coop Pronto', 'EUR']]);
});

test('Neon, Yuh und Wise', () => {
  const neon = `"Date";"Amount";"Original amount";"Original currency";"Exchange rate";"Description";"Subject";"Category";"Tags";"Wise";"Spaces"
"2024-01-31";"-17.50";"";"";"";"Pizzeria Da Luca";"";"restaurants";"";"no";"no"
"2024-01-30";"250.00";"";"";"";"Max Muster";"Zurück";"income";"";"no";"no"
`;
  let r = run(neon);
  assert.equal(r.bank, 'Neon');
  assert.deepEqual(plain(r.items.map(i => [i.date, i.amount, i.text])), [['2024-01-31', 17.5, 'Pizzeria Da Luca']]);

  const yuh = `DATE;ACTIVITY TYPE;ACTIVITY NAME;DEBIT;DEBIT CURRENCY;CREDIT;CREDIT CURRENCY;CARD NUMBER;LOCALITY;RECIPIENT;SENDER;FEES/COMMISSION;BUY/SELL;QUANTITY;ASSET;PRICE PER UNIT
31.01.2024;PAYMENT_TRANSACTION_OUT;"Migros";-22.35;CHF;;;****1234;Zürich;;;;;;;
30.01.2024;BANK_AUTO_ORDER_EXECUTED;"Lohn";;;5400;CHF;;;;;;;;;
`;
  r = run(yuh);
  assert.equal(r.bank, 'Yuh');
  assert.deepEqual(plain(r.items.map(i => [i.date, i.amount, i.text, i.currency])), [['2024-01-31', 22.35, 'Migros', 'CHF']]);

  const wise = `TransferWise ID,Date,Amount,Currency,Description,Payment Reference,Running Balance,Exchange From,Exchange To,Exchange Rate,Payer Name,Payee Name,Payee Account Number,Merchant
CARD-123,31-01-2024,-9.99,EUR,Card transaction of 9.99 EUR issued by Spotify,,50.01,,,,,,,Spotify
`;
  r = run(wise);
  assert.equal(r.bank, 'Wise');
  assert.deepEqual(plain(r.items.map(i => [i.date, i.amount, i.text])), [['2024-01-31', 9.99, 'Spotify']]);
});

test('Kreditkarte mit nur positiven Beträgen und Datei ohne Kopfzeile', () => {
  const cc = `Datum;Beschreibung;Betrag
03.02.2024;Galaxus.ch;129.00
05.02.2024;Restaurant Hiltl;64.50
`;
  let r = run(cc);
  assert.equal(r.sign, 'pos');
  assert.equal(r.items.length, 2);
  const bare = `03.02.2024;Digitec;-99.90
05.02.2024;Lohn;5400.00
06.02.2024;Coop;-12.35
`;
  r = run(bare);
  assert.deepEqual(plain(r.items.map(i => [i.date, i.amount, i.text])), [['2024-02-06', 12.35, 'Coop'], ['2024-02-03', 99.9, 'Digitec']]);
  assert.equal(r.header[0], 'Spalte 1');
  // Vorzeichen von Hand umdrehen
  const p = B.read(cc);
  assert.equal(B.extract(p, { ...p.map, sign: 'neg' }).items.length, 0);
});

test('Keine Kontobewegungen: verständlicher Fehler', () => {
  assert.throws(() => B.read(''), /leer/);
  assert.throws(() => B.read('Hallo\nWelt\n'), /Kontoauszug/);
});

test('Buchungstexte werden gekürzt', () => {
  assert.equal(B.cleanText('Einkauf ZKB Visa Debit Card Nr. xxxx 1234, Migros Zürich'), 'Migros Zürich');
  assert.equal(B.cleanText('TWINT *Coop Pronto'), 'Coop Pronto');
  assert.equal(B.cleanText('KAUF/ONLINE SHOPPING VOM 12.01.2024 KARTEN NR. XXXX1234 GALAXUS.CH'), 'Galaxus.ch');
  assert.equal(B.cleanText('Spotify AB 1234567890123'), 'Spotify AB');
  assert.ok(B.cleanText('x'.repeat(80)).length <= 40);
});
