export type Cohort = {
  name: string;
  userIds: string[];
};

export function cohortSize(cohort: Cohort): number {
  return cohort.userIds.length;
}
