import {Stack, StackProps} from 'aws-cdk-lib';
import {Construct} from 'constructs';
import {
    GatewayVpcEndpointAwsService,
    InterfaceVpcEndpointAwsService,
    InterfaceVpcEndpointService,
    IVpc,
    Peer,
    Port,
    SecurityGroup,
    SubnetType,
    Vpc
} from "aws-cdk-lib/aws-ec2";
import {
    ApplicationListener,
    ApplicationLoadBalancer,
    ApplicationProtocol,
    ListenerAction,
    ListenerCondition
} from "aws-cdk-lib/aws-elasticloadbalancingv2";
import {
    Cluster,
    ContainerImage,
    FargateService,
    FargateTaskDefinition,
    ListenerConfig,
    LogDriver,
    Protocol
} from "aws-cdk-lib/aws-ecs";
import {Repository} from "aws-cdk-lib/aws-ecr";
import {HttpApi, HttpMethod, HttpRoute, HttpRouteKey, VpcLink} from "@aws-cdk/aws-apigatewayv2-alpha";
import {HttpAlbIntegration} from "@aws-cdk/aws-apigatewayv2-integrations-alpha";

export class HttpApiPrivateIntegrationEcsStack extends Stack {

    private vpc: IVpc;
    private internalAlb: ApplicationLoadBalancer;
    private internalAlbListener: ApplicationListener

    constructor(scope: Construct, id: string, props?: StackProps) {
        super(scope, id, props);

        //Creating a VPC
        this.setupVpc();

        //Creating internal load balancer and configuration
        this.setupAlb();

        //Creating VPC endpoints for ECR
        this.setupVpcEndpointsForEcr()

        //Creating the ECS service
        this.setupEcsService();

        //Creating API gateway private integration with ECS
        this.setupApiGatewayVpcLink();
    }

    ///////////////////////////////////////////////////////////////////////////////////////////////////////////////////

    private setupVpc = () => {
        this.vpc = new Vpc(this, 'VPC', {
            maxAzs: 2,
            natGateways: 0
        });
    }

    ///////////////////////////////////////////////////////////////////////////////////////////////////////////////////

    private setupAlb = () => {
        const internalAlbSg = new SecurityGroup(this, 'InternalAlbSg', {
            vpc: this.vpc,
        });
        internalAlbSg.addIngressRule(Peer.anyIpv4(), Port.tcp(80));


        this.internalAlb = new ApplicationLoadBalancer(this, 'InternalAlb', {
            vpc: this.vpc,
            internetFacing: false,
            vpcSubnets: {subnetType: SubnetType.PRIVATE_ISOLATED},
            securityGroup: internalAlbSg
        });

        this.internalAlbListener = this.internalAlb.addListener('InternalHttpListener', {
            port: 80
        });

        this.internalAlbListener.addAction('DefaultAction', {
            action: ListenerAction.fixedResponse(200, {
                messageBody: "No routes defined"
            })
        });


    }

    ///////////////////////////////////////////////////////////////////////////////////////////////////////////////////

    private setupEcsService = () => {

        //Creating the ECS task cluster
        const ecsCluster = new Cluster(this, 'ECSCluster', {
            clusterName: 'SampleApi',
            vpc: this.vpc
        });

        //Creating the ECS task definition
        const taskDefinition = new FargateTaskDefinition(this, 'EcsTaskDefinition', {
            memoryLimitMiB: 512,
            cpu: 256
        });

        //Creating the container definition
        const containerDefinition = taskDefinition.addContainer('SampleApi', {
            image: ContainerImage.fromEcrRepository(Repository.fromRepositoryName(this, 'SampleApi', 'sample-api')),
            logging: LogDriver.awsLogs({
                streamPrefix: 'SampleApi-Logs'
            }),
            portMappings: [{
                containerPort: 80,
                protocol: Protocol.TCP
            }]
        });

        //Creating the ECS service
        const ecsService = new FargateService(this, 'ECSService', {
            cluster: ecsCluster,
            taskDefinition: taskDefinition,
            desiredCount: 2,
            assignPublicIp: false
        });

        //Register ECS service with the load balancer
        ecsService.registerLoadBalancerTargets({
                containerName: containerDefinition.containerName,
                newTargetGroupId: 'SampleApiTargetGroup',
                listener: ListenerConfig.applicationListener(this.internalAlbListener, {
                    protocol: ApplicationProtocol.HTTP,
                    priority: 1,
                    healthCheck: {
                        path: '/'
                    },
                    conditions: [
                        ListenerCondition.pathPatterns(['/'])
                    ]
                })
            },
            {
                containerName: containerDefinition.containerName,
                newTargetGroupId: 'SampleApiCustomerTargetGroup',
                listener: ListenerConfig.applicationListener(this.internalAlbListener, {
                    protocol: ApplicationProtocol.HTTP,
                    priority: 2,
                    healthCheck: {
                        path: '/'
                    },
                    conditions: [
                        ListenerCondition.pathPatterns(['/customers'])
                    ]
                })
            });
    }

    ///////////////////////////////////////////////////////////////////////////////////////////////////////////////////

    private setupVpcEndpointsForEcr = () => {
        //Get private/isolated subnets
        const selectedSubnets = this.vpc.selectSubnets({
            subnetType: SubnetType.PRIVATE_ISOLATED
        });

        //Creating a security group for interface endpoints
        const interfaceEndpointSecurityGroup = new SecurityGroup(this, 'InterfaceEndpointSecurityGroup', {
            vpc: this.vpc
        });

        for (const privateSubnet of selectedSubnets.subnets) {
            interfaceEndpointSecurityGroup.addIngressRule(Peer.ipv4(privateSubnet.ipv4CidrBlock), Port.tcp(443));
        }

        //Creating the interface endpoint for com.amazonaws.us-east-1.ecr.dkr
        this.vpc.addInterfaceEndpoint('EcrInterfaceEndpointDkr', {
            service: new InterfaceVpcEndpointService('com.amazonaws.us-east-1.ecr.dkr', 443),
            subnets: {
                subnetType: SubnetType.PRIVATE_ISOLATED
            },
            securityGroups: [interfaceEndpointSecurityGroup],
            privateDnsEnabled: true
        });

        //Creating the interface endpoint for com.amazonaws.us-east-1.ecr.api
        this.vpc.addInterfaceEndpoint('EcrInterfaceEndpointApi', {
            service: new InterfaceVpcEndpointService('com.amazonaws.us-east-1.ecr.api', 443),
            subnets: {
                subnetType: SubnetType.PRIVATE_ISOLATED
            },
            securityGroups: [interfaceEndpointSecurityGroup],
            privateDnsEnabled: true
        });

        //Creating the interface endpoint for CloudWatch logs
        this.vpc.addInterfaceEndpoint('CloudWatchInterfaceEndpoint', {
            service: InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS,
            subnets: {
                subnetType: SubnetType.PRIVATE_ISOLATED
            },
            securityGroups: [interfaceEndpointSecurityGroup],
            privateDnsEnabled: true
        });

        //Creating the gateway endpoint for S3
        this.vpc.addGatewayEndpoint('S3GatewayEndpoint', {
            service: GatewayVpcEndpointAwsService.S3,
            subnets: [{subnetType: SubnetType.PRIVATE_ISOLATED}]
        });
    }

    ///////////////////////////////////////////////////////////////////////////////////////////////////////////////////

    private setupApiGatewayVpcLink = () => {
        //Get private/isolated subnets
        const selectedSubnets = this.vpc.selectSubnets({
            subnetType: SubnetType.PRIVATE_ISOLATED
        });

        //Creating a VPC link for HTTP API
        const httpVpcLink = new VpcLink(this, 'HttpVpcLink', {
            vpc: this.vpc,
            vpcLinkName: "HttpVpcLink-ECS",
            subnets: selectedSubnets,
        });

        //Creating a HTTP API
        const httpApi = new HttpApi(this, 'HttpApi', {
            apiName: 'sampleApi-ECS'
        });

        //API integration
        const httpApiIntegration = new HttpAlbIntegration('HttpApiIntegration', this.internalAlbListener, {
            method: HttpMethod.ANY,
            vpcLink: httpVpcLink
        });

        //HTTP route
        const httpRoute = new HttpRoute(this, 'HttpRoute', {
            httpApi: httpApi,
            integration: httpApiIntegration,
            routeKey: HttpRouteKey.with('/{proxy+}', HttpMethod.ANY)
        });
    }

    ////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
}
