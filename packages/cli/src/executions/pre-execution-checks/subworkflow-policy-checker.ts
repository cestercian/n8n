import { Logger } from '@n8n/backend-common';
import { GlobalConfig } from '@n8n/config';
import type { Project } from '@n8n/db';
import { Service } from '@n8n/di';
import { type INode, type IWorkflowSettings, type WorkflowSettings } from 'n8n-workflow';

import { SubworkflowPolicyDenialError } from '@/errors/subworkflow-policy-denial.error';
import { AccessService } from '@/services/access.service';
import { OwnershipService } from '@/services/ownership.service';
import { UrlService } from '@/services/url.service';

type Policy = WorkflowSettings.CallerPolicy;
type DenialPolicy = Exclude<Policy, 'any'>;

/** Minimal shape needed to evaluate caller policy. Avoids constructing a full Workflow. */
export type SubworkflowPolicyTarget = {
	id?: string;
	settings?: IWorkflowSettings;
};

@Service()
export class SubworkflowPolicyChecker {
	constructor(
		private readonly logger: Logger,
		private readonly ownershipService: OwnershipService,
		private readonly globalConfig: GlobalConfig,
		private readonly accessService: AccessService,
		private readonly urlService: UrlService,
	) {}

	/**
	 * Whether the parent workflow is allowed to call the sub-workflow.
	 * Same rules as {@link check}, but returns a boolean instead of throwing.
	 */
	async isAllowedToCall(
		subworkflow: SubworkflowPolicyTarget,
		parentWorkflowId: string,
	): Promise<boolean> {
		const result = await this.evaluate(subworkflow, parentWorkflowId);
		return result.allowed;
	}

	/**
	 * Check whether the parent workflow is allowed to call the subworkflow.
	 */
	async check(
		subworkflow: SubworkflowPolicyTarget,
		parentWorkflowId: string,
		node?: INode,
		userId?: string,
	) {
		const result = await this.evaluate(subworkflow, parentWorkflowId);
		if (result.allowed) return;

		const { subworkflowId, policy } = result;
		this.logDenial({ parentWorkflowId, subworkflowId, policy });

		const subworkflowProject =
			result.subworkflowProject ??
			(await this.findProjects({ parentWorkflowId, subworkflowId })).subworkflowProject;

		const errorDetails = await this.errorDetails(subworkflowProject, subworkflowId, userId);

		throw new SubworkflowPolicyDenialError({
			subworkflowId,
			subworkflowProject,
			node,
			instanceUrl: this.urlService.getInstanceBaseUrl(),
			...errorDetails,
		});
	}

	private async evaluate(
		subworkflow: SubworkflowPolicyTarget,
		parentWorkflowId: string,
	): Promise<
		| { allowed: true }
		| { allowed: false; subworkflowId: string; policy: DenialPolicy; subworkflowProject?: Project }
	> {
		const { id: subworkflowId } = subworkflow;

		if (!subworkflowId) return { allowed: true }; // e.g. when running a subworkflow loaded from a file

		const policy = this.findPolicy(subworkflow);

		if (policy === 'any') return { allowed: true };

		if (policy === 'workflowsFromAList' && this.isListed(subworkflow, parentWorkflowId)) {
			return { allowed: true };
		}

		if (policy === 'workflowsFromSameOwner') {
			const { parentWorkflowProject, subworkflowProject } = await this.findProjects({
				parentWorkflowId,
				subworkflowId,
			});
			if (parentWorkflowProject.id === subworkflowProject.id) {
				return { allowed: true };
			}
			return { allowed: false, subworkflowId, policy, subworkflowProject };
		}

		return { allowed: false, subworkflowId, policy };
	}

	private async errorDetails(subworkflowProject: Project, subworkflowId: string, userId?: string) {
		const hasReadAccess = userId
			? await this.accessService.hasReadAccess(userId, subworkflowId)
			: false; /* no user ID in policy check for error workflow, so `false` to keep error message generic */

		if (subworkflowProject.type === 'team') return { hasReadAccess };

		const owner = await this.ownershipService.getPersonalProjectOwnerCached(subworkflowProject.id);

		return {
			hasReadAccess,
			ownerName: owner ? owner.firstName + ' ' + owner.lastName : 'No owner (team project)',
		};
	}

	/**
	 * Find the subworkflow's caller policy.
	 */
	private findPolicy(subworkflow: SubworkflowPolicyTarget): WorkflowSettings.CallerPolicy {
		return (
			subworkflow.settings?.callerPolicy ?? this.globalConfig.workflows.callerPolicyDefaultOption
		);
	}

	/**
	 * Find the projects that own the parent workflow and the subworkflow.
	 */
	private async findProjects({
		parentWorkflowId,
		subworkflowId,
	}: {
		parentWorkflowId: string;
		subworkflowId: string;
	}) {
		const [parentWorkflowProject, subworkflowProject] = await Promise.all([
			this.ownershipService.getWorkflowProjectCached(parentWorkflowId),
			this.ownershipService.getWorkflowProjectCached(subworkflowId),
		]);

		return { parentWorkflowProject, subworkflowProject };
	}

	/**
	 * Whether the subworkflow has the parent workflow listed as a caller.
	 */
	private isListed(subworkflow: SubworkflowPolicyTarget, parentWorkflowId: string) {
		const callerIds =
			subworkflow.settings?.callerIds
				?.split(',')
				.map((id) => id.trim())
				.filter((id) => id !== '') ?? [];

		return callerIds.includes(parentWorkflowId);
	}

	private readonly denialReasons: Record<DenialPolicy, string> = {
		none: 'Subworkflow may not be called by any workflow',
		workflowsFromAList: 'Subworkflow may be called only by workflows from an allowlist',
		workflowsFromSameOwner: 'Subworkflow may be called only by workflows owned by the same project',
	};

	private logDenial({
		parentWorkflowId,
		subworkflowId,
		policy,
	}: {
		parentWorkflowId: string;
		subworkflowId: string;
		policy: DenialPolicy;
	}) {
		this.logger.warn('[SubworkflowPolicyChecker] Subworkflow execution denied', {
			reason: this.denialReasons[policy],
			parentWorkflowId,
			subworkflowId,
		});
	}
}
