/*********************************************************************************************************************
 *  Copyright 2020 Amazon.com, Inc. or its affiliates. All Rights Reserved.                                           *
 *                                                                                                                    *
 *  Licensed under the Apache License, Version 2.0 (the "License"). You may not use this file except in compliance    *
 *  with the License. A copy of the License is located at                                                             *
 *                                                                                                                    *
 *      http://www.apache.org/licenses/LICENSE-2.0                                                                    *
 *                                                                                                                    *
 *  or in the 'license' file accompanying this file. This file is distributed on an 'AS IS' BASIS, WITHOUT WARRANTIES *
 *  OR CONDITIONS OF ANY KIND, express or implied. See the License for the specific language governing permissions    *
 *  and limitations under the License.                                                                                *
 *********************************************************************************************************************/

import * as cdk from '@aws-cdk/core';
import * as analytics from '@aws-cdk/aws-kinesisanalytics';
import * as iam from '@aws-cdk/aws-iam';
import * as kinesis from '@aws-cdk/aws-kinesis';
import * as logs from '@aws-cdk/aws-logs';
import * as lambda from '@aws-cdk/aws-lambda';
import * as s3 from '@aws-cdk/aws-s3';

import { ExecutionRole } from './lambda-role-cloudwatch';

export interface FlinkApplicationProps {
    readonly inputStream: kinesis.IStream;
    readonly outputBucket: s3.IBucket;

    readonly logsRetentionDays: logs.RetentionDays;
    readonly logLevel: string;
    readonly metricsLevel: string;

    readonly codeBucketArn: string;
    readonly codeFileKey: string;

    readonly enableSnapshots: string;
    readonly enableAutoScaling: string;

    readonly subnetIds?: string[];
    readonly securityGroupIds?: string[];
}

export class FlinkApplication extends cdk.Construct {
    private readonly Application: analytics.CfnApplicationV2;
    private readonly LogGroup: logs.LogGroup;

    public get ApplicationName() {
        return this.Application.ref;
    }

    public get LogGroupName() {
        return this.LogGroup.logGroupName;
    }

    public static get AllowedLogLevels(): string[] {
        return ['DEBUG', 'ERROR', 'INFO', 'WARN'];
    }

    public static get AllowedMetricLevels(): string[] {
        return ['APPLICATION', 'OPERATOR', 'PARALLELISM', 'TASK'];
    }

    constructor(scope: cdk.Construct, id: string, props: FlinkApplicationProps) {
        super(scope, id);

        if (!cdk.Token.isUnresolved(props.logLevel) && !FlinkApplication.AllowedLogLevels.includes(props.logLevel)) {
            throw new Error(`Unknown log level: ${props.logLevel}`);
        }

        if (!cdk.Token.isUnresolved(props.metricsLevel) &&!FlinkApplication.AllowedMetricLevels.includes(props.metricsLevel)) {
            throw new Error(`Unknown metrics level: ${props.metricsLevel}`);
        }

        this.LogGroup = new logs.LogGroup(this, 'LogGroup', {
            retention: props.logsRetentionDays,
            removalPolicy: cdk.RemovalPolicy.RETAIN
        });

        const logStream = new logs.LogStream(this, 'LogStream', {
            logGroup: this.LogGroup,
            removalPolicy: cdk.RemovalPolicy.RETAIN
        });

        const role = this.createRole(props.codeBucketArn, props.codeFileKey);
        props.inputStream.grantRead(role);
        props.outputBucket.grantReadWrite(role);

        const autoScalingCondition = new cdk.CfnCondition(this, 'EnableAutoScaling', {
            expression: cdk.Fn.conditionEquals(props.enableAutoScaling, 'true')
        });

        const snapshotCondition = new cdk.CfnCondition(this, 'EnableSnapshots', {
            expression: cdk.Fn.conditionEquals(props.enableSnapshots, 'true')
        });

        this.Application = new analytics.CfnApplicationV2(this, 'Application', {
            runtimeEnvironment: 'FLINK-1_8',
            serviceExecutionRole: role.roleArn,
            applicationConfiguration: {
                applicationCodeConfiguration: {
                    codeContent: {
                        s3ContentLocation: {
                            bucketArn: props.codeBucketArn,
                            fileKey: props.codeFileKey
                        }
                    },
                    codeContentType: 'ZIPFILE'
                },
                environmentProperties: {
                    propertyGroups: [{
                        propertyGroupId: 'FlinkApplicationProperties',
                        propertyMap: {
                            'InputStreamName': props.inputStream.streamName,
                            'OutputBucketName': props.outputBucket.bucketName,
                            'Region': cdk.Aws.REGION
                        }
                    }]
                },
                flinkApplicationConfiguration: {
                    monitoringConfiguration: {
                        configurationType: 'CUSTOM',
                        logLevel: props.logLevel,
                        metricsLevel: props.metricsLevel
                    },
                    parallelismConfiguration: {
                        configurationType: 'CUSTOM',
                        autoScalingEnabled: cdk.Fn.conditionIf(autoScalingCondition.logicalId, true, false)
                    },
                    checkpointConfiguration: {
                        configurationType: 'DEFAULT'
                    }
                },
                applicationSnapshotConfiguration: {
                    snapshotsEnabled: cdk.Fn.conditionIf(snapshotCondition.logicalId, true, false)
                }
            }
        });

        this.configureLogging(logStream.logStreamName);

        this.createCustomResource(props.subnetIds, props.securityGroupIds);
    }

    private createRole(bucketArn: string, fileKey: string): iam.IRole {
        const role = new iam.Role(this, 'AppRole', {
            assumedBy: new iam.ServicePrincipal('kinesisanalytics.amazonaws.com')
        });

        const s3Policy = new iam.Policy(this, 'CodePolicy', {
            statements: [new iam.PolicyStatement({
                resources: [`${bucketArn}/${fileKey}`],
                actions: ['s3:GetObjectVersion', 's3:GetObject']
            })]
        });
        s3Policy.attachToRole(role);

        const logsPolicy = new iam.Policy(this, 'LogsPolicy', {
            statements: [
                new iam.PolicyStatement({
                    resources: [`arn:${cdk.Aws.PARTITION}:logs:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:log-group:*`],
                    actions: ['logs:DescribeLogGroups']
                }),
                new iam.PolicyStatement({
                    resources: [this.LogGroup.logGroupArn],
                    actions: ['logs:DescribeLogStreams', 'logs:PutLogEvents']
                })
            ]
        });
        logsPolicy.attachToRole(role);

        const vpcPolicy = new iam.Policy(this, 'VpcPolicy', {
            statements: [
                new iam.PolicyStatement({
                    resources: ['*'],
                    actions: [
                        'ec2:CreateNetworkInterface',
                        'ec2:DescribeNetworkInterfaces',
                        'ec2:DescribeVpcs',
                        'ec2:DeleteNetworkInterface',
                        'ec2:DescribeDhcpOptions',
                        'ec2:DescribeSubnets',
                        'ec2:DescribeSecurityGroups'
                    ]
                }),
                new iam.PolicyStatement({
                    resources: [`arn:${cdk.Aws.PARTITION}:ec2:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:network-interface/*`],
                    actions: ['ec2:CreateNetworkInterfacePermission']
                })
            ]
        });
        vpcPolicy.attachToRole(role);

        const cfnPolicy = vpcPolicy.node.defaultChild as iam.CfnPolicy;
        cfnPolicy.cfnOptions.metadata = {
            cfn_nag: {
                rules_to_suppress: [{
                    id: 'W12',
                    reason: 'Actions do not support resource level permissions'
                }]
            }
        };

        return role;
    }

    private configureLogging(logStreamName: string) {
        const logStreamArn = `arn:${cdk.Aws.PARTITION}:logs:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:log-group:${this.LogGroupName}:log-stream:${logStreamName}`;

        new analytics.CfnApplicationCloudWatchLoggingOptionV2(this, 'Logging', {
            applicationName: this.ApplicationName,
            cloudWatchLoggingOption: { logStreamArn }
        });
    }

    private createCustomResource(subnets?: string[], securityGroups?: string[]) {
        const vpcConfigDocument = new iam.PolicyDocument({
            statements: [new iam.PolicyStatement({
                resources: [
                    `arn:${cdk.Aws.PARTITION}:kinesisanalytics:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:application/${this.ApplicationName}`
                ],
                actions: [
                    'kinesisanalytics:AddApplicationVpcConfiguration',
                    'kinesisanalytics:DeleteApplicationVpcConfiguration',
                    'kinesisanalytics:DescribeApplication'
                ]
            })]
        });

        const customResouceRole = new ExecutionRole(this, 'CustomResourceRole', {
            inlinePolicyName: 'VpcConfigPolicy',
            inlinePolicyDocument: vpcConfigDocument
        });

        const customResourceFunction = new lambda.Function(this, 'CustomResource', {
            runtime: lambda.Runtime.PYTHON_3_8,
            handler: 'lambda_function.handler',
            role: customResouceRole.Role,
            code: lambda.Code.fromAsset('lambda/kda-vpc-config'),
            timeout: cdk.Duration.seconds(30)
        });

        new cdk.CustomResource(this, 'VpcConfiguration', {
            serviceToken: customResourceFunction.functionArn,
            properties: {
                ApplicationName: this.ApplicationName,
                SubnetIds: subnets ?? [],
                SecurityGroupIds: securityGroups ?? []
            },
            resourceType: 'Custom::VpcConfiguration'
        });
    }
}
