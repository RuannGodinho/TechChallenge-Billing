export class CheckEstimateApprovalUseCase {
    execute(estimate: { status: string } | undefined): boolean {
        return !!estimate && estimate.status === 'APPROVED';
    }
}
