import type { MockInstance } from 'vitest';
import { LicenseState } from '@n8n/backend-common';
import { createWorkflow, mockInstance, getPersonalProject, testDb } from '@n8n/backend-test-utils';
import type { CredentialsEntity, User } from '@n8n/db';
import {
	GLOBAL_OWNER_ROLE,
	WorkflowRepository,
	SharedWorkflowRepository,
	WorkflowEntity,
} from '@n8n/db';
import { Container } from '@n8n/di';
import { mock } from 'vitest-mock-extended';
import { InstanceSettings } from 'n8n-core';
import nock from 'nock';
import { v4 as uuid } from 'uuid';
import type { INode } from 'n8n-workflow';

import * as utils from '../shared/utils';
import { DynamicCredentialResolverService } from '@/modules/dynamic-credentials.ee/services/credential-resolver.service';
import { N8nResolverSeeder } from '@/modules/dynamic-credentials.ee/services/n8n-resolver-seeder.service';
import { Telemetry } from '@/telemetry';
import { createCredentials } from '../shared/db/credentials';
import { DynamicCredentialsConfig } from '@/modules/dynamic-credentials.ee/dynamic-credentials.config';

import { createUser } from '../shared/db/users';

mockInstance(Telemetry);

const licenseMock = mock<LicenseState>();
licenseMock.isLicensed.mockReturnValue(true);
Container.set(LicenseState, licenseMock);

process.env.N8N_ENV_FEAT_DYNAMIC_CREDENTIALS = 'true';

const testServer = utils.setupTestServer({
	endpointGroups: ['credentials'],
	enabledFeatures: ['feat:externalSecrets'],
	modules: ['dynamic-credentials'],
});

mockInstance(DynamicCredentialsConfig, {
	corsOrigin: 'https://app.example.com',
	corsAllowCredentials: false,
	endpointAuthToken: 'static-test-token',
});

const setupWorkflow = async () => {
	const owner = await createUser({ role: GLOBAL_OWNER_ROLE });
	const resolverService = Container.get(DynamicCredentialResolverService);

	const resolver = await resolverService.create({
		name: 'Test Resolver',
		type: 'credential-resolver.oauth2-1.0',
		config: {
			metadataUri: 'https://auth.example.com/.well-known/openid-configuration',
			clientId: 'test-client-id',
			clientSecret: 'test-client-secret',
			validation: 'oauth2-introspection',
		},
		user: owner,
	});

	const personalProject = await getPersonalProject(owner);

	const savedCredential = await createCredentials(
		{
			name: 'Test Dynamic Credential',
			type: 'OAuth2',
			data: '',
			isResolvable: true,
			resolverId: resolver.id,
		},
		personalProject,
	);

	const node: INode = {
		id: uuid(),
		name: 'Test Node',
		type: 'n8n-nodes-base.httpRequest',
		typeVersion: 1,
		position: [0, 0],
		parameters: {},
		credentials: {
			oAuth2Api: {
				id: savedCredential.id,
				name: savedCredential.name,
			},
		},
	};

	const workflow = new WorkflowEntity();
	workflow.name = 'Test Workflow';
	workflow.nodes = [node];
	workflow.active = true;
	workflow.versionId = uuid();
	workflow.connections = {};

	const workflowRepository = Container.get(WorkflowRepository);
	const savedWorkflow = await workflowRepository.save(workflow);

	await Container.get(SharedWorkflowRepository).save({
		workflow: savedWorkflow,
		user: owner,
		project: personalProject,
		role: 'workflow:owner',
	});

	return { savedWorkflow, savedCredential, owner, resolver };
};

describe('Workflow Status API', () => {
	let savedWorkflow: WorkflowEntity;
	let savedCredential: CredentialsEntity;
	let owner: User;
	let unrelatedMember: User;
	let isLeaderSpy: MockInstance;
	let resolverId: string;

	beforeAll(async () => {
		// Force leader role so N8nResolverSeeder.seed() runs (not no-op for followers).
		isLeaderSpy = vi
			.spyOn(Container.get(InstanceSettings), 'isLeader', 'get')
			.mockReturnValue(true);

		// Mock OAuth metadata endpoint for resolver validation
		nock.cleanAll();
		nock('https://auth.example.com')
			.persist()
			.get('/.well-known/openid-configuration')
			.reply(200, {
				issuer: 'https://auth.example.com',
				introspection_endpoint: 'https://auth.example.com/oauth/introspect',
				introspection_endpoint_auth_methods_supported: [
					'client_secret_basic',
					'client_secret_post',
				],
			});

		// Mock OAuth introspection endpoint for identity validation
		nock('https://auth.example.com')
			.persist()
			.post('/oauth/introspect')
			.reply(200, {
				active: true,
				sub: 'user-123',
				exp: Math.floor(Date.now() / 1000) + 3600,
			});

		await testDb.truncate([
			'User',
			'SharedWorkflow',
			'WorkflowEntity',
			'CredentialsEntity',
			'DynamicCredentialResolver',
		]);

		// Re-seed the system credential resolver, which the dynamic-credentials proxy
		// references for any workflow without an explicit `credentialResolverId`.
		await Container.get(N8nResolverSeeder).seed();

		const setup = await setupWorkflow();
		savedWorkflow = setup.savedWorkflow;
		savedCredential = setup.savedCredential;
		owner = setup.owner;
		resolverId = setup.resolver.id;

		// A second regular member with no relationship to the owner's workflow:
		// not the owner, no project membership, no sharing.
		unrelatedMember = await createUser();
	});

	afterAll(async () => {
		nock.cleanAll();
		isLeaderSpy.mockRestore();
		await testDb.terminate();
		testServer.httpServer.close();
	});

	describe('GET /workflows/:workflowId/execution-status', () => {
		describe('when a static auth token is provided', () => {
			it('should return the execution status of a workflow', async () => {
				const response = await testServer.authlessAgent
					.get(`/workflows/${savedWorkflow.id}/execution-status`)
					.set('Authorization', 'Bearer test-token')
					.set('X-Authorization', 'Bearer static-test-token')
					.expect(200);

				expect(response.body.data).toMatchObject({
					workflowId: savedWorkflow.id,
					readyToExecute: expect.any(Boolean),
					credentials: expect.arrayContaining([
						expect.objectContaining({
							credentialId: savedCredential.id,
							credentialName: savedCredential.name,
							credentialType: savedCredential.type,
							credentialStatus: expect.any(String),
						}),
					]),
				});
			});

			it('should return 401 if the static auth token is invalid', async () => {
				await testServer.authlessAgent
					.get(`/workflows/${savedWorkflow.id}/execution-status`)
					.set('Authorization', 'Bearer test-token')
					.set('X-Authorization', 'Bearer invalid-token')
					.expect(401);
			});

			it('should return 401 if the static auth token is missing', async () => {
				await testServer.authlessAgent
					.get(`/workflows/${savedWorkflow.id}/execution-status`)
					.set('Authorization', 'Bearer test-token')
					.expect(401);
			});

			it('should return 401 if the static auth token is empty', async () => {
				await testServer.authlessAgent
					.get(`/workflows/${savedWorkflow.id}/execution-status`)
					.set('Authorization', 'Bearer test-token')
					.set('X-Authorization', 'Bearer ')
					.expect(401);
			});
		});

		it('should return 401 if the authorization header is missing', async () => {
			await testServer.authlessAgent
				.get(`/workflows/${savedWorkflow.id}/execution-status`)
				.set('X-Authorization', 'Bearer static-test-token')
				.expect(401);
		});

		describe('when a user is authenticated via cookie', () => {
			it('should allow access without static auth token', async () => {
				const response = await testServer
					.authAgentFor(owner)
					.get(`/workflows/${savedWorkflow.id}/execution-status`)
					.set('Authorization', 'Bearer test-token')
					// Note: NO X-Authorization header provided
					.expect(200);

				expect(response.body.data).toMatchObject({
					workflowId: savedWorkflow.id,
					readyToExecute: expect.any(Boolean),
					credentials: expect.arrayContaining([
						expect.objectContaining({
							credentialId: savedCredential.id,
							credentialName: savedCredential.name,
							credentialType: savedCredential.type,
							credentialStatus: expect.any(String),
						}),
					]),
				});
			});

			it('should allow access even with invalid static token if cookie auth succeeds', async () => {
				const response = await testServer
					.authAgentFor(owner)
					.get(`/workflows/${savedWorkflow.id}/execution-status`)
					.set('Authorization', 'Bearer test-token')
					.set('X-Authorization', 'Bearer invalid-static-token') // Invalid token
					.expect(200);

				expect(response.body.data).toMatchObject({
					workflowId: savedWorkflow.id,
					readyToExecute: expect.any(Boolean),
					credentials: expect.arrayContaining([
						expect.objectContaining({
							credentialId: savedCredential.id,
							credentialName: savedCredential.name,
							credentialType: savedCredential.type,
							credentialStatus: expect.any(String),
						}),
					]),
				});
			});

			describe("when an unrelated authenticated member targets another user's workflow", () => {
				it('should not expose the credentials of a workflow the member cannot access', async () => {
					const response = await testServer
						.authAgentFor(unrelatedMember)
						.get(`/workflows/${savedWorkflow.id}/execution-status`)
						.set('Authorization', 'Bearer test-token');

					expect([403, 404]).toContain(response.status);
					expect(response.body?.data).toBeUndefined();
				});
			});
		});

		describe('when the workflow references another workflow', () => {
			const createExecuteWorkflowNode = (subWorkflowId: string): INode => ({
				id: uuid(),
				name: 'Execute Workflow',
				type: 'n8n-nodes-base.executeWorkflow',
				typeVersion: 1,
				position: [0, 0],
				parameters: {
					source: 'database',
					workflowId: { value: subWorkflowId },
				},
			});

			const createCredentialNode = (credential: CredentialsEntity): INode => ({
				id: uuid(),
				name: 'HTTP Request',
				type: 'n8n-nodes-base.httpRequest',
				typeVersion: 1,
				position: [0, 0],
				parameters: {},
				credentials: {
					oAuth2Api: {
						id: credential.id,
						name: credential.name,
					},
				},
			});

			it('should omit credentials from a referenced workflow the parent is not allowed to call', async () => {
				const memberParent = await createWorkflow(
					{
						name: 'Member parent',
						nodes: [createExecuteWorkflowNode(savedWorkflow.id)],
						connections: {},
					},
					unrelatedMember,
				);

				const response = await testServer
					.authAgentFor(unrelatedMember)
					.get(`/workflows/${memberParent.id}/execution-status`)
					.set('Authorization', 'Bearer test-token')
					.expect(200);

				const credentialIds = (
					response.body.data.credentials as Array<{ credentialId: string }>
				).map((c) => c.credentialId);
				expect(credentialIds).not.toContain(savedCredential.id);
			});

			it('should omit referenced-workflow credentials for static-token callers when the parent cannot call it', async () => {
				const memberParent = await createWorkflow(
					{
						name: 'Member parent static',
						nodes: [createExecuteWorkflowNode(savedWorkflow.id)],
						connections: {},
					},
					unrelatedMember,
				);

				const response = await testServer.authlessAgent
					.get(`/workflows/${memberParent.id}/execution-status`)
					.set('Authorization', 'Bearer test-token')
					.set('X-Authorization', 'Bearer static-test-token')
					.expect(200);

				const credentialIds = (
					response.body.data.credentials as Array<{ credentialId: string }>
				).map((c) => c.credentialId);
				expect(credentialIds).not.toContain(savedCredential.id);
			});

			it('should include credentials from a referenced workflow the parent is allowed to call', async () => {
				const ownerProject = await getPersonalProject(owner);
				const sameOwnerCredential = await createCredentials(
					{
						name: 'Same-owner sub credential',
						type: 'OAuth2',
						data: '',
						isResolvable: true,
						resolverId,
					},
					ownerProject,
				);
				const sameOwnerSub = await createWorkflow(
					{
						name: 'Owner sub',
						nodes: [createCredentialNode(sameOwnerCredential)],
						connections: {},
						settings: { credentialResolverId: resolverId },
					},
					owner,
				);
				const sameOwnerParent = await createWorkflow(
					{
						name: 'Owner parent',
						nodes: [createExecuteWorkflowNode(sameOwnerSub.id)],
						connections: {},
					},
					owner,
				);

				const response = await testServer
					.authAgentFor(owner)
					.get(`/workflows/${sameOwnerParent.id}/execution-status`)
					.set('Authorization', 'Bearer test-token')
					.expect(200);

				const credentialIds = (
					response.body.data.credentials as Array<{ credentialId: string }>
				).map((c) => c.credentialId);
				expect(credentialIds).toContain(sameOwnerCredential.id);
			});

			it('should include credentials from a referenced workflow that lists the parent as a caller', async () => {
				const ownerProject = await getPersonalProject(owner);
				const listedCredential = await createCredentials(
					{
						name: 'Listed-caller credential',
						type: 'OAuth2',
						data: '',
						isResolvable: true,
						resolverId,
					},
					ownerProject,
				);
				const memberParent = await createWorkflow(
					{
						name: 'Member listed parent',
						nodes: [],
						connections: {},
					},
					unrelatedMember,
				);
				const listedSub = await createWorkflow(
					{
						name: 'Listed sub',
						nodes: [createCredentialNode(listedCredential)],
						connections: {},
						settings: {
							callerPolicy: 'workflowsFromAList',
							callerIds: memberParent.id,
							credentialResolverId: resolverId,
						},
					},
					owner,
				);
				memberParent.nodes = [createExecuteWorkflowNode(listedSub.id)];
				await Container.get(WorkflowRepository).save(memberParent);

				const response = await testServer
					.authAgentFor(unrelatedMember)
					.get(`/workflows/${memberParent.id}/execution-status`)
					.set('Authorization', 'Bearer test-token')
					.expect(200);

				const credentialIds = (
					response.body.data.credentials as Array<{ credentialId: string }>
				).map((c) => c.credentialId);
				expect(credentialIds).toContain(listedCredential.id);
			});
		});
	});
});
