// Jamaica's 14 parishes plus rough centroids — good enough to seed a
// warehouse/shop's map point from a parish selection until the operator can
// drop a real pin (same tradeoff WarehouseSetupForm.jsx already makes on the
// frontend for the dashboard quick-setup flow).
export const PARISHES = [
    'Kingston',
    'St. Andrew',
    'St. Catherine',
    'Clarendon',
    'Manchester',
    'St. Elizabeth',
    'Westmoreland',
    'Hanover',
    'St. James',
    'Trelawny',
    'St. Ann',
    'St. Mary',
    'Portland',
    'St. Thomas',
];
export const PARISH_COORDS = {
    Kingston: { lat: 17.9712, lng: -76.7936 },
    'St. Andrew': { lat: 18.0333, lng: -76.7833 },
    'St. Catherine': { lat: 17.9909, lng: -77.0 },
    Clarendon: { lat: 17.9667, lng: -77.2333 },
    Manchester: { lat: 18.0456, lng: -77.5028 },
    'St. Elizabeth': { lat: 18.0333, lng: -77.75 },
    Westmoreland: { lat: 18.3, lng: -78.1333 },
    Hanover: { lat: 18.4, lng: -78.1333 },
    'St. James': { lat: 18.4762, lng: -77.8939 },
    Trelawny: { lat: 18.35, lng: -77.6167 },
    'St. Ann': { lat: 18.4333, lng: -77.2 },
    'St. Mary': { lat: 18.3667, lng: -76.9 },
    Portland: { lat: 18.1833, lng: -76.45 },
    'St. Thomas': { lat: 17.9, lng: -76.35 },
};
export function isParish(value) {
    return PARISHES.includes(value);
}
//# sourceMappingURL=parishes.js.map