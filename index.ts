import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import * as awsx from "@pulumi/awsx";

// Configuración
const config = new pulumi.Config();
const instanceType = config.get("instanceType") || "t3.micro";

// User Data con estrés automático
const userData = `#!/bin/bash
# Actualizar sistema (Amazon Linux 2)
yum update -y

# Instalar Apache y stress
amazon-linux-extras install -y epel
yum install -y httpd stress

# Configurar página web
echo "<!DOCTYPE html>
<html>
<head>
    <title>Autoscaling Test</title>
    <style>
        body { font-family: Arial, sans-serif; margin: 40px; }
        .info { background: #f0f0f0; padding: 20px; border-radius: 5px; }
    </style>
</head>
<body>
    <h1>🚀 Autoscaling Test - AWS + Pulumi</h1>
    <div class='info'>
        <h2>Instance Information:</h2>
        <p><strong>Instance ID:</strong> \$(curl -s http://169.254.169.254/latest/meta-data/instance-id)</p>
        <p><strong>Availability Zone:</strong> \$(curl -s http://169.254.169.254/latest/meta-data/placement/availability-zone)</p>
        <p><strong>Auto Stress:</strong> RUNNING (cada 5 minutos)</p>
    </div>
</body>
</html>" > /var/www/html/index.html

# Script de estrés automático
cat > /tmp/auto-stress.sh << 'EOF'
#!/bin/bash
while true; do
    sleep 300  # Esperar 5 minutos
    echo "\$(date): Iniciando stress test automático" >> /var/log/auto-stress.log
    # Stress CPU (4 procesos por 180 segundos)
    stress --cpu 4 --timeout 180s &
    # Stress memoria (1 proceso, 512MB por 180 segundos)
    stress --vm 1 --vm-bytes 512M --timeout 180s &
done
EOF

chmod +x /tmp/auto-stress.sh

# Ejecutar en background
nohup /tmp/auto-stress.sh > /dev/null 2>&1 &

# Iniciar Apache
systemctl start httpd
systemctl enable httpd

echo "Setup completado - Sistema listo para autoscaling"`;

// VPC SIMPLIFICADA - Sin argumentos problemáticos
const vpc = new awsx.ec2.Vpc("autoscaling-vpc", {
    cidrBlock: "10.0.0.0/16",
    numberOfAvailabilityZones: 2,
    natGateways: {
        strategy: "Single",
    },
});

// Security Group
const webSecurityGroup = new aws.ec2.SecurityGroup("web-sg", {
    vpcId: vpc.vpcId,
    description: "Security group for web instances",
    ingress: [
        {
            protocol: "tcp",
            fromPort: 80,
            toPort: 80,
            cidrBlocks: ["0.0.0.0/0"],
        },
        {
            protocol: "tcp",
            fromPort: 22,
            toPort: 22,
            cidrBlocks: ["0.0.0.0/0"],
        },
    ],
    egress: [
        {
            protocol: "-1",
            fromPort: 0,
            toPort: 0,
            cidrBlocks: ["0.0.0.0/0"],
        },
    ],
});

// AMI de Amazon Linux 2
const ami = aws.ec2.getAmi({
    owners: ["amazon"],
    mostRecent: true,
    filters: [
        {
            name: "name",
            values: ["amzn2-ami-hvm-2.0.*-x86_64-gp2"],
        },
    ],
}).then(result => result.id);

// Launch Template SIN key pair
const launchTemplate = new aws.ec2.LaunchTemplate("autoscaling-lt", {
    imageId: ami,
    instanceType: instanceType,
    vpcSecurityGroupIds: [webSecurityGroup.id],
    userData: Buffer.from(userData).toString("base64"),
    blockDeviceMappings: [{
        deviceName: "/dev/xvda",
        ebs: {
            volumeSize: 8,
            volumeType: "gp2",
            deleteOnTermination: "true",
        },
    }],
    tagSpecifications: [{
        resourceType: "instance",
        tags: {
            Name: "autoscaling-instance",
            Environment: "test",
            ManagedBy: "pulumi",
        },
    }],
});

// Auto Scaling Group
const autoScalingGroup = new aws.autoscaling.Group("autoscaling-group", {
    launchTemplate: {
        id: launchTemplate.id,
        version: "$Latest",
    },
    vpcZoneIdentifiers: vpc.privateSubnetIds,
    minSize: 1,
    maxSize: 3,
    desiredCapacity: 1,
    healthCheckType: "EC2",
    healthCheckGracePeriod: 300,
    tags: [
        {
            key: "Name",
            value: "autoscaling-instance",
            propagateAtLaunch: true,
        },
        {
            key: "Project",
            value: "autoscaling-stress-test",
            propagateAtLaunch: true,
        },
    ],
});

// Target Group para Load Balancer
const targetGroup = new aws.lb.TargetGroup("web-tg", {
    port: 80,
    protocol: "HTTP",
    vpcId: vpc.vpcId,
    targetType: "instance",
    healthCheck: {
        enabled: true,
        path: "/",
        port: "80",
        protocol: "HTTP",
        healthyThreshold: 2,
        unhealthyThreshold: 2,
        timeout: 3,
        interval: 30,
    },
});

// Load Balancer Application
const alb = new aws.lb.LoadBalancer("web-alb", {
    internal: false,
    loadBalancerType: "application",
    securityGroups: [webSecurityGroup.id],
    subnets: vpc.publicSubnetIds,
    tags: {
        Name: "web-alb",
    },
});

// Listener del Load Balancer
const listener = new aws.lb.Listener("web-listener", {
    loadBalancerArn: alb.arn,
    port: 80,
    protocol: "HTTP",
    defaultActions: [{
        type: "forward",
        targetGroupArn: targetGroup.arn,
    }],
});

// Attach Auto Scaling Group al Target Group - CORREGIDO
const attachment = new aws.autoscaling.Attachment("asg-alb-attachment", {
    autoscalingGroupName: autoScalingGroup.name,
    lbTargetGroupArn: targetGroup.arn, // ✅ CORRECTO
});

// Scaling Policies
const scaleUpPolicy = new aws.autoscaling.Policy("scale-up-policy", {
    autoscalingGroupName: autoScalingGroup.name,
    adjustmentType: "ChangeInCapacity",
    scalingAdjustment: 1,
    cooldown: 300,
});

const scaleDownPolicy = new aws.autoscaling.Policy("scale-down-policy", {
    autoscalingGroupName: autoScalingGroup.name,
    adjustmentType: "ChangeInCapacity",
    scalingAdjustment: -1,
    cooldown: 300,
});

// Alarmas basadas en número de solicitudes al Load Balancer
new aws.cloudwatch.MetricAlarm("high-request-alarm", {
    comparisonOperator: "GreaterThanThreshold",
    evaluationPeriods: 1,
    metricName: "RequestCount",
    namespace: "AWS/ApplicationELB",
    period: 60,
    statistic: "Sum",
    threshold: 30, // Ajusta según tu carga esperada
    alarmDescription: "Escalar arriba",
    alarmActions: [scaleUpPolicy.arn],
    dimensions: {
        LoadBalancer: alb.arn.apply(arn => {
  const parts = arn.split(":")[5]; // e.g., "loadbalancer/app/web-alb/50dc6c495c0c9188"
  const lbName = parts.replace("loadbalancer/", ""); // "app/web-alb/50dc6c495c0c9188"
  return lbName;
}),

    },
});

new aws.cloudwatch.MetricAlarm("low-request-alarm", {
    comparisonOperator: "LessThanThreshold",
    evaluationPeriods: 3,
    metricName: "RequestCount",
    namespace: "AWS/ApplicationELB",
    period: 120,
    statistic: "Sum",
    threshold: 10,
    alarmDescription: "Escalar abajo",
    alarmActions: [scaleDownPolicy.arn],
    dimensions: {
        LoadBalancer: alb.arn.apply(arn => {
  const parts = arn.split(":")[5]; // e.g., "loadbalancer/app/web-alb/50dc6c495c0c9188"
  const lbName = parts.replace("loadbalancer/", ""); // "app/web-alb/50dc6c495c0c9188"
  return lbName;
}),

    },
});


// Export outputs
export const albDnsName = alb.dnsName;
export const autoScalingGroupName = autoScalingGroup.name;
export const vpcId = vpc.vpcId;
export const launchTemplateId = launchTemplate.id;