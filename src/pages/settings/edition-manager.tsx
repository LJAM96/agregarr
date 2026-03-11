import SettingsEditionManager from '@app/components/Settings/SettingsEditionManager';
import SettingsLayout from '@app/components/Settings/SettingsLayout';
import useRouteGuard from '@app/hooks/useRouteGuard';
import { Permission } from '@app/hooks/useUser';
import type { NextPage } from 'next';

const EditionManagerPage: NextPage = () => {
  useRouteGuard(Permission.ADMIN);
  return (
    <SettingsLayout>
      <SettingsEditionManager />
    </SettingsLayout>
  );
};

export default EditionManagerPage;
