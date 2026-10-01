import SettingsEditionManager from '@app/components/Settings/SettingsEditionManager';
import useRouteGuard from '@app/hooks/useRouteGuard';
import { Permission } from '@app/hooks/useUser';
import type { NextPage } from 'next';

const EditionsPage: NextPage = () => {
  useRouteGuard(Permission.ADMIN);
  return <SettingsEditionManager />;
};

export default EditionsPage;
