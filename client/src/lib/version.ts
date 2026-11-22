/** 빌드 시 루트 VERSION / package.json 에서 주입된 앱 버전 */
export const APP_VERSION: string = typeof __APP_VERSION__ === "string" && __APP_VERSION__ ? __APP_VERSION__ : "0.1.0";
