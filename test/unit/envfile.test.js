import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { parseEnv } from 'node:util';
import { maskSecret, updateEnvFile } from '../../src/envfile.js';

const dir = mkdtempSync(path.join(tmpdir(), 'envfile-'));
const fileFor = (name, body = '') => {
	const file = path.join(dir, name);
	writeFileSync(file, body, 'utf8');
	return file;
};

describe('updateEnvFile', () => {
	it('replaces a key where it is, keeping the comments and the other lines', async () => {
		const file = fileFor(
			'basic.env',
			['# the bot reads this at start', 'DISCORD_TOKEN=abc', 'OPENAI_API_KEY=sk-old', '', '# a note', 'PANEL=1', ''].join('\n'),
		);
		const result = await updateEnvFile(file, { OPENAI_API_KEY: 'sk-new-value', DEEPSEEK_API_KEY: 'sk-deep' });
		assert.deepEqual(result.changed.sort(), ['DEEPSEEK_API_KEY', 'OPENAI_API_KEY']);
		const written = readFileSync(file, 'utf8');
		assert.match(written, /# the bot reads this at start/);
		assert.match(written, /OPENAI_API_KEY=sk-new-value/);
		assert.match(written, /# a note/);
		assert.match(written, /DEEPSEEK_API_KEY=sk-deep/);
		assert.ok(!written.includes('sk-old'), 'the old key is gone');
		assert.ok(result.backup && readFileSync(result.backup, 'utf8').includes('sk-old'), 'a copy of the old file is kept');
	});

	it('appends a key that was not there, and quotes what the format would misread', async () => {
		const file = fileFor('append.env', 'PANEL=1\n');
		await updateEnvFile(file, { GREET_TEXT: 'hello there # not a comment' });
		const written = readFileSync(file, 'utf8');
		assert.match(written, /GREET_TEXT="hello there # not a comment"/);
		assert.match(written, /PANEL=1/);
	});

	// Node's .env parser knows no escapes: a quoted value ends at the first matching quote and "\n" between
	// double quotes becomes a line break. Every value here has to come back out exactly as it went in.
	it('writes values that Node reads back unchanged, whatever quotes or backslashes they hold', async () => {
		const values = {
			A_PLAIN: 'sk-proj-abc_DEF.123',
			A_SPACE: 'hello there # not a comment',
			A_DOUBLE: 'say "hi"',
			A_BACKSLASH: 'C:\\new\\folder',
			A_BOTH: `it's "quoted"`,
			A_ALL_BUT_BACKTICK: `it's "quoted" and \\n`,
		};
		const file = fileFor('roundtrip.env', 'PANEL=1\n');
		await updateEnvFile(file, values);
		const parsed = parseEnv(readFileSync(file, 'utf8'));
		for (const [key, value] of Object.entries(values)) assert.equal(parsed[key], value, key);
		assert.equal(parsed.PANEL, '1');
	});

	it('refuses a line break or another control character, and leaves the file as it was', async () => {
		const body = 'PANEL=1\nOPENAI_API_KEY=sk-old\n';
		const file = fileFor('inject.env', body);
		for (const value of ['sk-new\nOPENAI_BASE_URL=http://attacker.example', 'x"\nPANEL=0', 'a\rb', 'nul\u0000', 'tab\there', 'del\u007f']) {
			await assert.rejects(() => updateEnvFile(file, { OPENAI_API_KEY: value }), /cannot be written to \.env safely/u, JSON.stringify(value));
		}
		await assert.rejects(() => updateEnvFile(file, { OPENAI_API_KEY: 'fine', GREET_TEXT: `all ' " \` three` }), /cannot be written/u);
		assert.equal(readFileSync(file, 'utf8'), body, 'nothing was written, not even the entry that was fine');
		assert.equal(parseEnv(readFileSync(file, 'utf8')).OPENAI_BASE_URL, undefined);
	});

	it('refuses a key that is not a plain name', async () => {
		const file = fileFor('keys.env', 'PANEL=1\n');
		for (const key of ['BAD KEY', 'X=Y', '1ABC', 'NEW\nLINE', '']) {
			await assert.rejects(() => updateEnvFile(file, { [key]: 'value' }), /setting name/u, JSON.stringify(key));
		}
		assert.equal(readFileSync(file, 'utf8'), 'PANEL=1\n');
	});

	it('writes nothing when there is nothing to change', async () => {
		const file = fileFor('empty.env', 'PANEL=1\n');
		const before = readFileSync(file, 'utf8');
		const result = await updateEnvFile(file, {});
		assert.deepEqual(result.changed, []);
		assert.equal(result.backup, null);
		assert.equal(readFileSync(file, 'utf8'), before);
	});
});

describe('maskSecret', () => {
	it('shows which key it is, never the whole thing', () => {
		assert.equal(maskSecret('sk-proj-1234567890abcdef'), 'sk-pro…cdef');
		assert.equal(maskSecret(''), '');
		assert.equal(maskSecret('short'), '…');
	});
});
