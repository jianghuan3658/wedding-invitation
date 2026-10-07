import cloudbase from '@cloudbase/js-sdk/app';
import { registerAuth } from '@cloudbase/js-sdk/auth';
import { registerDatabase } from '@cloudbase/js-sdk/database';
import { registerFunctions } from '@cloudbase/js-sdk/functions';
import { registerRealtime } from '@cloudbase/js-sdk/realtime';
registerAuth(cloudbase);
registerDatabase(cloudbase);
registerFunctions(cloudbase);
registerRealtime(cloudbase);
export function createCloudbaseApp(config) { return cloudbase.init(config); }
