#!/usr/bin/env node
/**
 * Validate this package can be discovered/loaded by n8n as a community node
 * without requiring DB drivers to be installed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);
const pkg = require(path.join(root, 'package.json'));

const failures = [];
const ok = (cond, msg) => {
	if (!cond) failures.push(msg);
	else console.log(`OK  ${msg}`);
};

ok(typeof pkg.name === 'string' && /^(?:@[^/]+\/)?n8n-nodes-/.test(pkg.name), 'package name is n8n-nodes-*');
ok(Array.isArray(pkg.keywords) && pkg.keywords.includes('n8n-community-node-package'), 'has n8n-community-node-package keyword');
ok(pkg.n8n && typeof pkg.n8n === 'object', 'has n8n object');
ok(Number.isInteger(pkg.n8n?.n8nNodesApiVersion) && pkg.n8n.n8nNodesApiVersion > 0, 'n8nNodesApiVersion is positive integer');
ok(Array.isArray(pkg.n8n?.nodes) && pkg.n8n.nodes.length > 0, 'n8n.nodes is non-empty array');
ok(Array.isArray(pkg.n8n?.credentials) && pkg.n8n.credentials.length >= 2, 'n8n.credentials has both credential types');

ok(!pkg.dependencies || Object.keys(pkg.dependencies).length === 0, 'no runtime dependencies');
ok(!pkg.dependencies?.ibm_db, 'ibm_db is not a hard dependency');
ok(!pkg.peerDependencies?.ibm_db, 'ibm_db is not a peer dependency');
ok(
	pkg.peerDependencies &&
		Object.keys(pkg.peerDependencies).length === 1 &&
		pkg.peerDependencies['n8n-workflow'] === '*',
	'peerDependencies is only n8n-workflow: *',
);
ok(
	fs.existsSync(path.join(root, 'dist/nodes/vendor/foxschema-core.cjs')),
	'bundled foxschema-core.cjs exists',
);

for (const p of pkg.n8n?.nodes ?? []) {
	ok(typeof p === 'string' && p.startsWith('dist/'), `node path starts with dist/: ${p}`);
	ok(fs.existsSync(path.join(root, p)), `node file exists: ${p}`);
	ok(p.endsWith('.node.js'), `node path ends with .node.js: ${p}`);
	const jsonPath = p.replace(/\.js$/, '.json');
	ok(fs.existsSync(path.join(root, jsonPath)), `codex json exists: ${jsonPath}`);
	const base = path.dirname(path.join(root, p));
	const js = fs.readFileSync(path.join(root, p), 'utf8');
	const iconMatches = [...js.matchAll(/file:([^'"]+\.(?:svg|png))/g)];
	for (const m of iconMatches) {
		ok(fs.existsSync(path.join(base, m[1])), `icon exists next to node: ${m[1]}`);
	}
	try {
		const mod = require(path.join(root, p));
		const exported =
			mod.FoxSchemaMultiSqlQueries ||
			Object.values(mod).find((v) => typeof v === 'function');
		ok(typeof exported === 'function', `exports a node class from ${p}`);
		if (typeof exported === 'function') {
			const instance = new exported();
			ok(!!instance.description?.name, 'node description.name present');
			ok(!!instance.description?.displayName, 'node description.displayName present');
			ok(typeof instance.execute === 'function', 'node has execute');
		}
	} catch (e) {
		failures.push(`failed to require ${p}: ${e.message}`);
	}
}

for (const p of pkg.n8n?.credentials ?? []) {
	ok(typeof p === 'string' && p.startsWith('dist/'), `credential path starts with dist/: ${p}`);
	ok(fs.existsSync(path.join(root, p)), `credential file exists: ${p}`);
	try {
		const mod = require(path.join(root, p));
		const Cred = Object.values(mod).find((v) => typeof v === 'function');
		ok(typeof Cred === 'function', `exports a credential class from ${p}`);
		if (typeof Cred === 'function') {
			const c = new Cred();
			ok(!!c.name && !!c.properties, `credential ${c.name} has name + properties`);
			ok(!!c.test?.request, `credential ${c.name} has test.request`);
		}
	} catch (e) {
		failures.push(`failed to require ${p}: ${e.message}`);
	}
}

ok(Array.isArray(pkg.files) && pkg.files.includes('dist'), 'files includes dist');

if (failures.length) {
	console.error('\nFAIL');
	for (const f of failures) console.error(` - ${f}`);
	process.exit(1);
}

console.log('\nPackage format looks installable into n8n.');
