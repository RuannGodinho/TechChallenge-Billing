const { runScanner } = require('../scripts/run-sonar.cjs');

describe('Sonar scanner launcher', () => {
    test('preserves scanner arguments without invoking a shell', () => {
        const env = { SONAR_TOKEN: 'token with spaces $(not-a-command) `literal`' };
        const spawn = jest.fn().mockReturnValue({ status: 7 });
        expect(runScanner(env, spawn)).toBe(7);
        expect(spawn).toHaveBeenCalledWith('npx', [
            'sonar-scanner', `-Dsonar.token=${env.SONAR_TOKEN}`, `-Dsonar.login=${env.SONAR_TOKEN}`,
        ], { stdio: 'inherit', shell: false, env });
    });
    test.each([{ status: 0 }, { status: 3 }, { status: null, signal: 'SIGTERM' }])('propagates scanner exit status: %p', result => {
        expect(runScanner({ SONAR_TOKEN: 'test' }, () => result)).toBe(result.status ?? 1);
    });
    test('fails when the scanner cannot start and skips when the token is absent', () => {
        const stderr = jest.spyOn(console, 'error').mockImplementation(() => undefined);
        expect(runScanner({ SONAR_TOKEN: 'test' }, () => ({ error: new Error('ENOENT'), status: null }))).toBe(1);
        const spawn = jest.fn();
        expect(runScanner({}, spawn)).toBe(0);
        expect(spawn).not.toHaveBeenCalled();
        stderr.mockRestore();
    });
});
