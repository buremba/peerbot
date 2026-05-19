import { describe, expect, test } from 'bun:test';
import { fileSystemSourceFromUri } from '../file-source.js';
import { GitFileSource } from '../sources/git-file-source.js';
import { LocalFileSource } from '../sources/local-file-source.js';
import { TarballFileSource } from '../sources/tarball-file-source.js';

describe('fileSystemSourceFromUri', () => {
  test('routes git+https:// to GitFileSource', () => {
    const src = fileSystemSourceFromUri('git+https://github.com/foo/bar.git@main');
    expect(src).toBeInstanceOf(GitFileSource);
  });

  test('routes git+https:// without ref to GitFileSource', () => {
    const src = fileSystemSourceFromUri('git+https://github.com/foo/bar.git');
    expect(src).toBeInstanceOf(GitFileSource);
  });

  test('routes https://….tar.gz to TarballFileSource', () => {
    const src = fileSystemSourceFromUri('https://example.com/x.tar.gz');
    expect(src).toBeInstanceOf(TarballFileSource);
  });

  test('routes https://….tgz to TarballFileSource', () => {
    const src = fileSystemSourceFromUri('https://example.com/x.tgz');
    expect(src).toBeInstanceOf(TarballFileSource);
  });

  test('strips query string before extension check', () => {
    const src = fileSystemSourceFromUri('https://example.com/x.tar.gz?sig=abc');
    expect(src).toBeInstanceOf(TarballFileSource);
  });

  test('routes file:/// to LocalFileSource', () => {
    const src = fileSystemSourceFromUri('file:///tmp/abc/');
    expect(src).toBeInstanceOf(LocalFileSource);
  });

  test('rejects git+ssh:// with helpful error', () => {
    expect(() => fileSystemSourceFromUri('git+ssh://git@github.com/foo/bar.git')).toThrow(
      /SSH auth/i,
    );
  });

  test('rejects bare ssh:// with helpful error', () => {
    expect(() => fileSystemSourceFromUri('ssh://git@github.com/foo/bar.git')).toThrow(
      /SSH auth/i,
    );
  });

  test('rejects git+http:// (no plaintext git)', () => {
    expect(() => fileSystemSourceFromUri('git+http://example.com/foo.git')).toThrow(
      /Plaintext git/i,
    );
  });

  test('rejects http:// tarball (no plaintext http)', () => {
    expect(() => fileSystemSourceFromUri('http://example.com/x.tar.gz')).toThrow(
      /Plaintext tarball/i,
    );
  });

  test('rejects .zip URLs', () => {
    expect(() => fileSystemSourceFromUri('https://example.com/x.zip')).toThrow(
      /\.tar\.gz/i,
    );
  });

  test('rejects raw https:// without tarball extension', () => {
    expect(() => fileSystemSourceFromUri('https://example.com/some/dir/')).toThrow(
      /\.tar\.gz/i,
    );
  });

  test('rejects s3:// with future-scheme message', () => {
    expect(() => fileSystemSourceFromUri('s3://bucket/key.tar.gz')).toThrow(
      /future implementation/i,
    );
  });

  test('rejects gs:// with future-scheme message', () => {
    expect(() => fileSystemSourceFromUri('gs://bucket/key.tar.gz')).toThrow(
      /future implementation/i,
    );
  });

  test('rejects empty string', () => {
    expect(() => fileSystemSourceFromUri('')).toThrow(/non-empty/i);
  });

  test('rejects totally unknown scheme', () => {
    expect(() => fileSystemSourceFromUri('weird://thing')).toThrow(/Unsupported/i);
  });
});
