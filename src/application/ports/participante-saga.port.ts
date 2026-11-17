export interface IParticipanteSagaPort {
    execute(message: unknown): Promise<void>;
}
