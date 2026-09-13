const test = require('node:test');
const assert = require('node:assert/strict');
const {
  extractAPICalls,
  extractPrismaSchemas,
  extractSQLSchemas,
} = require('../dist/core/scanner/ContractAnalyzer.js');

test('extracts fetch and axios client contracts from TypeScript AST', () => {
  const source = `
    async function load() {
      await fetch('/api/users', { method: 'POST' });
      await axios.get('/api/projects');
      await axios({ url: '/api/tasks', method: 'PATCH' });
    }
  `;
  const calls = extractAPICalls('/repo/src/client.ts', source);
  assert.deepEqual(
    calls.map(call => [call.method, call.path, call.client]),
    [
      ['POST', '/api/users', 'fetch'],
      ['GET', '/api/projects', 'axios'],
      ['PATCH', '/api/tasks', 'axios'],
    ],
  );
});

test('extracts Prisma model fields and relationships', () => {
  const source = `
    model User {
      id String @id @default(uuid())
      email String @unique
      posts Post[] @relation("UserPosts")
    }

    model Post {
      id String @id
      author User @relation(fields: [authorId], references: [id])
      authorId String
    }
  `;
  const schemas = extractPrismaSchemas('/repo/prisma/schema.prisma', source);
  assert.equal(schemas.length, 2);
  assert.equal(schemas[0].tableName, 'User');
  assert.equal(schemas[0].columns.find(column => column.name === 'id').primaryKey, true);
  assert.equal(schemas[0].columns.find(column => column.name === 'email').unique, true);
  assert.equal(schemas[0].relations[0].targetTable, 'Post');
});

test('extracts SQL CREATE TABLE columns and foreign keys with nested defaults', () => {
  const source = `
    CREATE TABLE users (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      email text NOT NULL UNIQUE
    );
    CREATE TABLE posts (
      id uuid PRIMARY KEY,
      user_id uuid NOT NULL REFERENCES users(id),
      created_at timestamp DEFAULT now(),
      CONSTRAINT posts_user_fk FOREIGN KEY (user_id) REFERENCES users(id)
    );
  `;
  const schemas = extractSQLSchemas('/repo/migrations/001.sql', source);
  assert.equal(schemas.length, 2);
  const posts = schemas.find(schema => schema.tableName === 'posts');
  assert.ok(posts);
  assert.equal(posts.columns.find(column => column.name === 'user_id').nullable, false);
  assert.equal(posts.columns.find(column => column.name === 'user_id').references.table, 'users');
  assert.ok(posts.relations.some(relation => relation.targetTable === 'users'));
});
