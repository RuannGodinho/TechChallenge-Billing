export class CheckCheckoutEligibilityUseCase {
    execute(completedEstimateId: string | undefined, estimate: { id: string; status: string } | undefined): boolean {
        return !!completedEstimateId && !!estimate && estimate.status === 'APPROVED' && completedEstimateId === estimate.id;
    }
}
