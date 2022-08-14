import {setup, defaultClient, TelemetryClient} from 'applicationinsights';

declare global {
    var insightsDefClient: TelemetryClient | any;
}

export function initialiseInsights() {
    if (process.env.APPLICATIONINSIGHTS_CONNECTION_STRING && !global.insightsDefClient) {
        console.log(process.env.APPLICATIONINSIGHTS_CONNECTION_STRING);
        setup(process.env.APPLICATIONINSIGHTS_CONNECTION_STRING) //
            .setAutoCollectConsole(true)
            .setAutoCollectDependencies(false)
            .setAutoCollectExceptions(true)
            .setAutoCollectHeartbeat(true)
            .setAutoCollectPerformance(true, true)
            .setAutoCollectRequests(true)
            .setAutoDependencyCorrelation(false)
            .setSendLiveMetrics(true)
            .setUseDiskRetryCaching(true)
            //        .setAutoPopulateAzureProperties(true)
            .start();
        global.insightsDefClient = defaultClient;
    }
}

export function trackMetric(name: string, value: number): void {
    if (global.insightsDefClient) {
        global.insightsDefClient.trackMetric({name, value});
    }
}
