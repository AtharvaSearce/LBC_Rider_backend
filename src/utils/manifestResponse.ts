import { Manifest, Rider, Stop } from '@prisma/client';

type ManifestWithRelations = Manifest & {
  rider: Rider;
  stops: Stop[];
};

export function formatManifestResponse(manifest: ManifestWithRelations) {
  return {
    id: manifest.manifestId,
    routeName: manifest.routeName,
    date: manifest.date.toISOString(),
    status: manifest.status,
    totalStops: manifest.totalStops,
    completedStops: manifest.completedStops,
    failedStops: manifest.failedStops,
    rider: {
      id: manifest.rider.id,
      name: manifest.rider.name,
      phone: manifest.rider.phone,
      hubName: manifest.rider.hubName,
      zone: manifest.rider.zone,
    },
    stops: manifest.stops.map((stop) => ({
      id: stop.stopCode,
      sequence: stop.sequence,
      status: stop.status,
      recipient: {
        name: stop.recipientName,
        phone: stop.recipientPhone,
      },
      address: {
        text: stop.addressText,
        lat: stop.addressLat,
        lng: stop.addressLng,
      },
      trackingNumber: stop.trackingNumber,
      serviceType: stop.serviceType,
      codAmount: Number(stop.codAmount),
      packageDetails: stop.packageDetails,
      specialInstructions: stop.specialInstructions ?? '',
      distanceKm: stop.distanceKm,
      eta: stop.eta,
      attemptCount: stop.attemptCount,
      maxAttempts: stop.maxAttempts,
    })),
  };
}
