import type { Config } from 'jest';

const config: Config = {
    preset: 'ts-jest',
    testEnvironment: 'node',
    clearMocks: true,
    roots: ['<rootDir>/src', '<rootDir>/test'],
    collectCoverage: true,
    collectCoverageFrom: [
        'src/**/*.ts',
        '!src/**/*.d.ts',
        '!src/**/index.ts',
        '!src/config/**',
        '!src/**/*.interface.ts',
        '!src/Interfaces/**',
        '!src/application/dtos/**',
        '!src/**/*.dto.ts',
        '!src/**/*.dtos.ts',
        '!src/application/ports/**',
    ],
    coverageDirectory: 'coverage',
    coverageProvider: 'v8',
    coverageReporters: ['json', 'text', 'lcov', 'clover'],
    coverageThreshold: {
        global: { statements: 81, branches: 81, functions: 81, lines: 81 },
    },
};

export default config;
