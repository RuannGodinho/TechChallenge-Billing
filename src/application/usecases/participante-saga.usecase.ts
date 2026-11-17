import { IParticipanteSagaPort } from '../ports/participante-saga.port';
export class ProcessarComandoSagaUseCase {
    constructor(private readonly participante: IParticipanteSagaPort) { }
    execute(message: unknown) { return this.participante.execute(message); }
}
